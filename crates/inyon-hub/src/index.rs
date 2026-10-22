//! index.ts's own routes: sign-in, the first password, phones, pairing machines, the inyon command
//! on this machine, and the table of every route the hub has.

use std::rc::Rc;

use axum::http::Method;
use inyon_core::clock::now_ms;
use inyon_core::hosts::http_error::{http, HubResult};
use inyon_core::hosts::registry::registry;
use inyon_core::platform::rt::sleep;
use inyon_protocol::{HostConfig, HostKind, HostState, VERSION};
use serde_json::{json, Map, Value};

use crate::auth::{clear_cookie, client_address, close_sockets, is_authed, issue_cookie, loopback, recent_sign_in, refresh_cookie, revoke_session, try_login};
use crate::http::{field, json as answer, ok, ok_json, random_base64url, same, set_header, sha256, str_or_empty, Req, Resp};
use crate::password::{check_password, has_password, password_problem, set_password};
use crate::phones::{claim_phone, hub_about, issue_ticket, list_phones, new_pair_code, phone_for, revoke_phone, CODE_TTL};
use crate::server::{api, ctx, h, raw, ApiHandler, Opts, Route, Routes, OPEN, OPEN_OWNER, OWNER};

/// HTTPS directly, or behind a local HTTPS proxy (Tailscale Serve, Caddy…) where the hub only sees http.
pub fn secure_request(req: &Req) -> bool {
    req.https || (loopback(&req.ip()) && req.header("x-forwarded-proto").as_deref() == Some("https"))
}

/// The hub address that goes into the pairing one-liners (shell and PowerShell).
fn pair_origin(req: &Req, origin: Option<&Value>) -> HubResult<String> {
    let given = match origin {
        None | Some(Value::Null) => req.origin(),
        Some(v) => crate::http::js_string(v),
    };
    let hub = given.trim_end_matches('/').to_owned();
    if !inyon_core::re!(r"^https?://[A-Za-z0-9.:\[\]_-]+$").is_match(&hub) {
        return Err(http(400, "Unexpected hub address"));
    }
    Ok(hub)
}

/// A machine as the command lists it: who it is, whether it's reachable, what it runs.
fn local_node(s: &HostState) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), json!(s.config.id));
    m.insert("name".into(), json!(s.config.name));
    m.insert("kind".into(), serde_json::to_value(s.config.kind).unwrap_or(Value::Null));
    m.insert("status".into(), serde_json::to_value(s.status).unwrap_or(Value::Null));
    let mut put = |k: &str, v: Option<Value>| {
        if let Some(v) = v {
            m.insert(k.into(), v);
        }
    };
    put("hostname", s.hostname.clone().filter(|h| !h.is_empty()).map(Value::String));
    put("os", s.os.clone().filter(|h| !h.is_empty()).map(Value::String));
    put("version", s.node_version.clone().filter(|h| !h.is_empty()).map(Value::String));
    put("lastSeen", s.last_seen.filter(|t| *t != 0).map(|t| json!(t)));
    put("error", s.error.clone().filter(|h| !h.is_empty()).map(Value::String));
    m.insert("agents".into(), serde_json::to_value(&s.agents).unwrap_or(Value::Null));
    m.insert("sessions".into(), json!(s.sessions.len()));
    Value::Object(m)
}

/// The inyon command on this machine reads the hub's machines over loopback with the token the hub
/// wrote as it started, readable only by this user.
fn from_this_machine(req: &Req) -> bool {
    if !loopback(&req.ip()) {
        return false;
    }
    let given = req.query_get("token").unwrap_or_else(|| {
        let auth = req.header("authorization").unwrap_or_default();
        inyon_core::re!(r"(?i)^Bearer\s+").replace(&auth, "").into_owned()
    });
    let token = &ctx().local_token;
    given.len() == token.len() && same(&given, token)
}

fn with_cookie(mut r: Resp, cookie: &str) -> Resp {
    set_header(&mut r, "set-cookie", cookie);
    r
}

fn post(routes: &mut Routes, pattern: &str, f: ApiHandler, o: Opts) {
    routes.methods(pattern, vec![(Method::POST, api(f, o))]);
}

const ALREADY: &str = "This hub already has a password. Sign in instead.";

pub fn routes(updater: Rc<crate::hub_update::HubUpdater>) -> Routes {
    let mut r = Routes::default();
    r.add(
        "/api/session",
        Route::Any(api(
            h(|req| async move {
                let authed = is_authed(&req);
                // sliding sign-in: a session in use keeps going, one left alone for 30 days ends
                let cookie = if authed { refresh_cookie(&req, secure_request(&req)) } else { None };
                let c = ctx();
                let mut body = json!({ "authed": authed, "setup": !has_password(), "setupCode": c.setup_code.borrow().is_some() && !has_password() });
                if authed {
                    body["version"] = json!(VERSION);
                    body["commit"] = json!(c.hub_commit);
                }
                let res = ok_json(&body);
                Ok(match cookie {
                    Some(c) => with_cookie(res, &c),
                    None => res,
                })
            }),
            OPEN,
        )),
    );
    post(
        &mut r,
        "/api/setup",
        h(|mut req| async move {
            if has_password() {
                return Err(http(409, ALREADY));
            }
            let b = req.json_body(8 * 1024).await?;
            let now = now_ms();
            let c = ctx();
            if c.setup_attempts.get().1 < now {
                c.setup_attempts.set((0, now + 60_000));
            }
            let Some(setup_code) = c.setup_code.borrow().clone() else { return Err(http(409, ALREADY)) };
            let code = str_or_empty(field(&b, "code")?).trim().to_lowercase();
            if c.setup_attempts.get().0 >= 8 {
                return Err(http(429, "Too many attempts. Try again in a minute."));
            }
            if code.len() != setup_code.len() || !same(&code, &setup_code) {
                let (n, reset) = c.setup_attempts.get();
                c.setup_attempts.set((n + 1, reset));
                sleep(400).await;
                return Err(http(401, "That setup code is not right. `inyon hub code` on the hub machine shows it; it is also in the hub log and in ~/.inyon/setup-code."));
            }
            let password = str_or_empty(field(&b, "password")?);
            if let Some(problem) = password_problem(&password) {
                return Err(http(400, problem));
            }
            // a second request racing this one finds the password already set
            if has_password() {
                return Err(http(409, ALREADY));
            }
            set_password(&password)?;
            let _ = std::fs::remove_file(c.data_dir.join("setup-code"));
            Ok(with_cookie(ok(), &issue_cookie(secure_request(&req))))
        }),
        OPEN_OWNER,
    );
    post(
        &mut r,
        "/api/password",
        h(|mut req| async move {
            let b = req.json_body(8 * 1024).await?;
            if !check_password(&str_or_empty(field(&b, "current")?)).await {
                sleep(400).await;
                return Err(http(401, "Your current password is not right"));
            }
            let next = str_or_empty(field(&b, "next")?);
            if let Some(problem) = password_problem(&next) {
                return Err(http(400, problem));
            }
            // a new password signs out every other browser; this one gets a fresh sign-in
            set_password(&crate::http::str_raw(field(&b, "next")?))?;
            // connections opened with the old password end too (this browser reconnects signed in)
            close_sockets(None);
            Ok(with_cookie(ok(), &issue_cookie(secure_request(&req))))
        }),
        OWNER,
    );
    post(
        &mut r,
        "/api/login",
        h(|mut req| async move {
            let b = req.json_body(8 * 1024).await?;
            let password = str_or_empty(field(&b, "password")?);
            // behind a local proxy every request comes from loopback: count guesses per real client
            let client = client_address(&req.ip(), req.header("x-forwarded-for").as_deref());
            if let Err(e) = try_login(&client, &password).await {
                return Ok(answer(401, &json!({ "error": e })));
            }
            Ok(with_cookie(ok(), &issue_cookie(secure_request(&req))))
        }),
        OPEN_OWNER,
    );
    post(
        &mut r,
        "/api/logout",
        h(|req| async move {
            revoke_session(&req);
            Ok(with_cookie(ok(), &clear_cookie()))
        }),
        OPEN,
    );
    // ---------- phones: the app pairs by scanning a code this hub's web app shows ----------
    r.methods("/api/phones", vec![(Method::GET, api(h(|req| async move { Ok(ok_json(&list_phones(&req))) }), Opts::default()))]);
    post(
        &mut r,
        "/api/phones/pair",
        h(|mut req| async move {
            // a code hands out a token that outlives this session, so the password must be fresh
            if !recent_sign_in(&req, CODE_TTL) {
                return Err(http(403, "Sign in again to pair a phone."));
            }
            let b = req.json_body(8 * 1024).await?;
            Ok(ok_json(&new_pair_code(field(&b, "origin")?, now_ms())?))
        }),
        OWNER,
    );
    post(
        &mut r,
        "/api/phones/claim",
        h(|mut req| async move {
            let b = req.json_body(8 * 1024).await?;
            let client = client_address(&req.ip(), req.header("x-forwarded-for").as_deref());
            match claim_phone(&client, &b, now_ms()) {
                Ok(v) => Ok(ok_json(&v)),
                Err(e) => {
                    // wrong digits cost a moment, as a wrong setup code does
                    if e.status == Some(401) {
                        sleep(400).await;
                    }
                    Err(e)
                }
            }
        }),
        OPEN,
    );
    post(
        &mut r,
        "/api/phones/ticket",
        h(|req| async move {
            let phone = phone_for(&req).ok_or_else(|| http(403, "Only a paired phone connects with a ticket."))?;
            Ok(ok_json(&json!({ "ticket": issue_ticket(&phone.id, now_ms()), "hub": hub_about() })))
        }),
        Opts::default(),
    );
    r.methods(
        "/api/phones/:id",
        vec![(
            Method::DELETE,
            api(
                h(|req| async move {
                    if !revoke_phone(&req.param("id")) {
                        return Err(http(404, "Unknown phone"));
                    }
                    Ok(ok())
                }),
                OWNER,
            ),
        )],
    );
    post(
        &mut r,
        "/api/hosts/pair",
        h(|mut req| async move {
            let b = req.body().await?;
            let name = Some(str_or_empty(field(&b, "name")?).trim().to_owned()).filter(|n| !n.is_empty()).unwrap_or_else(|| "Laptop".into());
            let id = crate::core_routes::slug(&name, "node");
            let hub = pair_origin(&req, field(&b, "origin")?)?;
            let token = random_base64url(32);
            let (unix, windows) = crate::node_dist::dist().pair_commands(&hub, &token).await?;
            let unique = crate::core_routes::new_host_id(&id, "node");
            let config: HostConfig = serde_json::from_value(json!({ "id": unique, "name": name, "kind": "node", "tokenHash": sha256(&token), "tokenIssuedAt": now_ms() }))
                .map_err(|e| inyon_core::hosts::http_error::HubError::plain(e.to_string()))?;
            registry().add(config, true)?;
            Ok(ok_json(&json!({ "id": unique, "token": token, "command": unix, "commands": { "unix": unix, "windows": windows } })))
        }),
        Opts::default(),
    );
    // a new command for a machine that was added but never ran it (or lost its token)
    post(
        &mut r,
        "/api/hosts/:id/pair",
        h(|mut req| async move {
            let id = req.param("id");
            let rt = registry().get(&id).filter(|rt| rt.borrow().host.config().kind == HostKind::Node).ok_or_else(|| http(404, "Unknown machine"))?;
            if rt.borrow().state.status == inyon_protocol::HostStatus::Online {
                return Err(http(409, "This machine is connected; remove it first to pair it again"));
            }
            let b = req.body().await?;
            let hub = pair_origin(&req, field(&b, "origin")?)?;
            let token = random_base64url(32);
            let (unix, windows) = crate::node_dist::dist().pair_commands(&hub, &token).await?;
            registry().set_node_token(&id, &sha256(&token))?;
            Ok(ok_json(&json!({ "id": id, "token": token, "command": unix, "commands": { "unix": unix, "windows": windows } })))
        }),
        Opts::default(),
    );
    // ---------- the inyon command on this machine, over loopback with the local token ----------
    r.add(
        "/api/local/nodes",
        Route::Any(raw(|req| async move {
            if !from_this_machine(&req) {
                return answer(403, &json!({ "error": "Only the inyon command on this machine may ask" }));
            }
            let nodes: Vec<Value> = registry().overview().iter().map(local_node).collect();
            ok_json(&json!({ "v": 1, "ok": true, "nodes": nodes }))
        })),
    );
    crate::node_dist::add(&mut r);
    crate::core_routes::add(&mut r);
    crate::push::add(&mut r);
    crate::pages::add(&mut r);
    updater.add(&mut r);
    r
}
