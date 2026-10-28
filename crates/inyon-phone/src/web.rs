//! The JavaScript side: what `startPhone` takes and gives back (apps/hub/src/phone/types.ts), the
//! browser's event loop as the core's runtime, the app's store, `fetch`, and Request and Response
//! in and out. Only globals every engine has (setTimeout, fetch, Request, Response), so the same
//! module runs in the Android WebView, a browser tab and Bun's tests.

use std::cell::Cell;
use std::rc::Rc;

use futures_util::future::LocalBoxFuture;
use http::{HeaderMap, HeaderName, HeaderValue, Method};
use inyon_api::body::Body;
use inyon_api::clients::{self, ClientRef};
use inyon_api::http::{Req, Resp};
use inyon_core::platform::fetch::{FetchRequest, FetchResponse, Fetcher};
use inyon_core::platform::rt::{install, Runtime};
use inyon_core::platform::store::Store;
use js_sys::{Array, Function, Object, Promise, Reflect, Uint8Array, JSON};
use serde_json::Value;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::{future_to_promise, JsFuture};

use crate::phone::{self, Options, Phone};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = setTimeout)]
    fn set_timeout(f: &Function, ms: f64) -> JsValue;
    #[wasm_bindgen(js_name = fetch)]
    fn global_fetch(url: &str, init: &Object) -> Promise;
    #[wasm_bindgen(js_namespace = AbortSignal, js_name = timeout)]
    fn abort_after(ms: f64) -> JsValue;
    #[wasm_bindgen(js_namespace = console, js_name = log)]
    fn console_log(line: &str);
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(line: &str);

    #[wasm_bindgen(js_name = Response)]
    type JsResponse;
    #[wasm_bindgen(constructor, js_class = "Response")]
    fn new(body: &JsValue, init: &Object) -> JsResponse;
}

// ---------- the runtime ----------

/// The browser's event loop: tasks are promises' continuations, timers are setTimeout.
struct BrowserRuntime;

impl Runtime for BrowserRuntime {
    fn spawn(&self, fut: LocalBoxFuture<'static, ()>) {
        wasm_bindgen_futures::spawn_local(fut);
    }
    fn sleep(&self, ms: u64) -> LocalBoxFuture<'static, ()> {
        let p = Promise::new(&mut |resolve, _| {
            set_timeout(&resolve, ms as f64);
        });
        Box::pin(async move {
            let _ = JsFuture::from(p).await;
        })
    }
    fn now_ms(&self) -> u64 {
        js_sys::Date::now() as u64
    }
}

// ---------- the store ----------

/// The app's `PhoneStore` (IndexedDB behind a map it loaded first): values cross as JSON.
struct JsStore(JsValue);

impl JsStore {
    fn call(&self, name: &str, args: &[&JsValue]) -> Result<JsValue, JsValue> {
        let f: Function = Reflect::get(&self.0, &name.into())?.dyn_into()?;
        f.apply(&self.0, &args.iter().copied().collect::<Array>())
    }
}

impl Store for JsStore {
    fn get(&self, key: &str) -> Option<Value> {
        let v = self.call("get", &[&key.into()]).ok()?;
        if v.is_undefined() {
            return None;
        }
        inyon_core::js::json::parse(&JSON::stringify(&v).ok()?.as_string()?)
    }
    fn set(&self, key: &str, value: &Value) -> Result<(), String> {
        let v = JSON::parse(&inyon_core::js::stringify(value)).map_err(|e| describe(&e))?;
        self.call("set", &[&key.into(), &v]).map(|_| ()).map_err(|e| describe(&e))
    }
    fn del(&self, key: &str) {
        let _ = self.call("del", &[&key.into()]);
    }
    fn keys(&self, prefix: &str) -> Vec<String> {
        self.call("keys", &[&prefix.into()]).ok().map(|v| Array::from(&v).iter().filter_map(|k| k.as_string()).collect()).unwrap_or_default()
    }
}

// ---------- fetch ----------

/// The few requests the core makes to the web (an agent's newest version on npm).
struct WebFetcher;

impl Fetcher for WebFetcher {
    fn fetch(&self, req: FetchRequest) -> LocalBoxFuture<'static, Result<FetchResponse, String>> {
        Box::pin(async move {
            let init = Object::new();
            let headers = Object::new();
            for (k, v) in &req.headers {
                set(&headers, k, &v.into());
            }
            set(&init, "method", &req.method.as_str().into());
            set(&init, "headers", &headers);
            if let Some(b) = &req.body {
                set(&init, "body", &Uint8Array::from(b.as_slice()));
            }
            if req.timeout_ms > 0 {
                set(&init, "signal", &abort_after(req.timeout_ms as f64));
            }
            let res = JsFuture::from(global_fetch(&req.url, &init)).await.map_err(|e| describe(&e))?;
            let status = Reflect::get(&res, &"status".into()).ok().and_then(|s| s.as_f64()).unwrap_or(0.0) as u16;
            let body = JsFuture::from(call0(&res, "arrayBuffer").map_err(|e| describe(&e))?.dyn_into::<Promise>().map_err(|e| describe(&e))?).await.map_err(|e| describe(&e))?;
            Ok(FetchResponse { status, body: Uint8Array::new(&body).to_vec() })
        })
    }
}

// ---------- requests and answers ----------

/// A JavaScript Request as a route handler takes it.
async fn request_in(req: &JsValue) -> Result<Req, JsValue> {
    let method: Method = Reflect::get(req, &"method".into())?.as_string().unwrap_or_default().parse().unwrap_or(Method::GET);
    let href = Reflect::get(req, &"url".into())?.as_string().unwrap_or_default();
    // the app asks for "/api/…" against its own page, so a path alone is fine too
    let url = url::Url::parse(&href).or_else(|_| url::Url::parse("http://phone.invalid")?.join(&href)).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let mut headers = HeaderMap::new();
    if let Some(iter) = js_sys::try_iter(&Reflect::get(req, &"headers".into())?)? {
        for pair in iter {
            let pair = Array::from(&pair?);
            let (Some(k), Some(v)) = (pair.get(0).as_string(), pair.get(1).as_string()) else { continue };
            if let (Ok(k), Ok(v)) = (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(&v)) {
                headers.append(k, v);
            }
        }
    }
    let body = if method == Method::GET || method == Method::HEAD {
        None
    } else {
        let buf = JsFuture::from(call0(req, "arrayBuffer")?.dyn_into::<Promise>()?).await?;
        Some(Body::from(Uint8Array::new(&buf).to_vec()))
    };
    Ok(Req {
        method,
        path: url.path().to_owned(),
        query: url.query().unwrap_or_default().to_owned(),
        headers,
        peer: ([127, 0, 0, 1], 0).into(),
        https: url.scheme() == "https",
        body,
        params: vec![],
        extensions: http::Extensions::new(),
    })
}

/// An answer as a JavaScript Response. A streamed body (a file being sent) is read whole first.
async fn response_out(res: Resp) -> Result<JsValue, JsValue> {
    let (parts, body) = res.into_parts();
    let headers = Array::new();
    for (k, v) in &parts.headers {
        headers.push(&Array::of2(&k.as_str().into(), &String::from_utf8_lossy(v.as_bytes()).into_owned().into()));
    }
    let init = Object::new();
    set(&init, "status", &parts.status.as_u16().into());
    set(&init, "headers", &headers);
    let status = parts.status.as_u16();
    // these may carry no body at all
    let body = if matches!(status, 101 | 204 | 205 | 304) {
        JsValue::NULL
    } else {
        let bytes = body.bytes().await.map_err(|e| JsValue::from_str(&e.to_string()))?;
        Uint8Array::from(&bytes[..]).into()
    };
    Ok(JsResponse::new(&body, &init).into())
}

// ---------- startPhone ----------

thread_local! {
    static STARTED: Cell<bool> = const { Cell::new(false) };
}

/// `startPhone({ store, ssh, name })`: the core, started once per page. `ssh` and `name` are taken
/// as the TS core takes them; the servers and computers they reach come over in later steps.
#[wasm_bindgen(js_name = startPhone)]
pub async fn start_phone(o: JsValue) -> Result<PhoneRuntime, JsValue> {
    if STARTED.with(|s| s.replace(true)) {
        return Err(JsValue::from_str("The phone core is already running in this page"));
    }
    install(Rc::new(BrowserRuntime));
    inyon_core::platform::console::set_sink(Some(Rc::new(|error, line| if error { console_error(line) } else { console_log(line) })));
    let store = Reflect::get(&o, &"store".into())?;
    if store.is_undefined() {
        return Err(JsValue::from_str("startPhone needs a store"));
    }
    let phone = phone::start(Options { store: Rc::new(JsStore(store)), fetcher: Some(Rc::new(WebFetcher)) });
    Ok(PhoneRuntime(Rc::new(phone)))
}

/// What `startPhone` gives back (PhoneRuntime in types.ts).
#[wasm_bindgen]
pub struct PhoneRuntime(Rc<Phone>);

#[wasm_bindgen]
impl PhoneRuntime {
    /// Answers an /api request the way the hub would: a Request in, a promise of a Response.
    pub fn fetch(&self, req: JsValue) -> Promise {
        let phone = self.0.clone();
        future_to_promise(async move { response_out(phone.answer(request_in(&req).await?).await).await })
    }

    /// A screen of the app connecting: `send` gets each message, already parsed.
    pub fn connect(&self, send: Function) -> PhoneConnection {
        let c = self.0.connect(move |text| {
            if let Ok(msg) = JSON::parse(&text) {
                let _ = send.call1(&JsValue::NULL, &msg);
            }
        });
        PhoneConnection(c)
    }

    /// The app is back in the foreground: check connections now.
    pub fn resume(&self) {
        self.0.resume();
    }

    /// The app went to the background (true) or came back (false).
    pub fn background(&self, hidden: bool) {
        self.0.background(hidden);
    }
}

/// One connected screen (PhoneConnection in types.ts).
#[wasm_bindgen]
pub struct PhoneConnection(ClientRef);

#[wasm_bindgen]
impl PhoneConnection {
    /// What the screen sent, as the text it would have sent the hub's WebSocket.
    pub fn message(&self, raw: &str) {
        clients::client_message(&self.0, raw);
    }

    pub fn close(&self) {
        clients::close_client(&self.0);
    }
}

// ---------- helpers ----------

fn set(o: &Object, k: &str, v: &JsValue) {
    let _ = Reflect::set(o, &k.into(), v);
}

fn call0(o: &JsValue, name: &str) -> Result<JsValue, JsValue> {
    Reflect::get(o, &name.into())?.dyn_into::<Function>()?.call0(o)
}

/// An exception's message, for an error string.
fn describe(e: &JsValue) -> String {
    Reflect::get(e, &"message".into()).ok().and_then(|m| m.as_string()).or_else(|| e.as_string()).unwrap_or_else(|| "failed".into())
}
