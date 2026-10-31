//! How sessions are organised (from 0.24; see inyon_core::features::organize): one read of all of
//! it, and a route for each thing that changes. Every change goes out to the apps at once, in the
//! overview on `/ws` and on the organize stream of `/ws2`.

use http::Method;
use inyon_core::clock::now_ms;
use inyon_core::features::organize::{self, SessionPatch};
use serde_json::{json, Value};

use crate::http::{json_of, ok, ok_json, pane_param, Req, Resp};
use crate::routes::{guarded, h, Routes};
use inyon_core::hosts::http_error::HubResult;

/// `{ session }`: the mark after the change, or null when nothing is kept about it any more.
fn session(m: Option<inyon_protocol::SessionMark>) -> Resp {
    ok_json(&json!({ "session": m }))
}

async fn body(r: &mut Req) -> HubResult<Value> {
    r.body().await
}

pub fn add(routes: &mut Routes) {
    use Method as M;
    guarded(routes, "/api/organize", vec![(M::GET, h(|_r| async { Ok(json_of(&organize::current())) }))]);
    guarded(
        routes,
        "/api/hosts/:id/panes/:pane/organize",
        vec![(
            M::PATCH,
            h(|mut r| async move {
                let p = SessionPatch::read(&body(&mut r).await?, now_ms())?;
                Ok(session(organize::mark_pane(&r.param("id"), &pane_param(&r.param("pane")), &p)?))
            }),
        )],
    );
    guarded(
        routes,
        "/api/organize/sessions/:sid",
        vec![
            (
                M::PATCH,
                h(|mut r| async move {
                    let p = SessionPatch::read(&body(&mut r).await?, now_ms())?;
                    Ok(session(organize::mark_by_id(&r.param("sid"), &p)?))
                }),
            ),
            (
                M::DELETE,
                h(|r| async move {
                    organize::forget(&r.param("sid"))?;
                    Ok(ok())
                }),
            ),
        ],
    );
    guarded(
        routes,
        "/api/organize/order",
        vec![(
            M::PUT,
            h(|mut r| async move {
                organize::set_order(&body(&mut r).await?)?;
                Ok(ok())
            }),
        )],
    );
    guarded(routes, "/api/organize/projects", vec![(M::POST, h(|mut r| async move { Ok(json_of(&organize::add_project(&body(&mut r).await?)?)) }))]);
    guarded(
        routes,
        "/api/organize/projects/:pid",
        vec![
            (M::PATCH, h(|mut r| async move { Ok(json_of(&organize::update_project(&r.param("pid"), &body(&mut r).await?)?)) })),
            (
                M::DELETE,
                h(|r| async move {
                    organize::remove_project(&r.param("pid"))?;
                    Ok(ok())
                }),
            ),
        ],
    );
    guarded(routes, "/api/organize/groups", vec![(M::POST, h(|mut r| async move { Ok(json_of(&organize::add_group(&body(&mut r).await?)?)) }))]);
    guarded(
        routes,
        "/api/organize/groups/:gid",
        vec![
            (M::PATCH, h(|mut r| async move { Ok(json_of(&organize::update_group(&r.param("gid"), &body(&mut r).await?)?)) })),
            (
                M::DELETE,
                h(|r| async move {
                    organize::remove_group(&r.param("gid"))?;
                    Ok(ok())
                }),
            ),
        ],
    );
    guarded(routes, "/api/organize/spaces", vec![(M::POST, h(|mut r| async move { Ok(json_of(&organize::add_space(&body(&mut r).await?)?)) }))]);
    guarded(
        routes,
        "/api/organize/spaces/:wid",
        vec![
            (M::PATCH, h(|mut r| async move { Ok(json_of(&organize::update_space(&r.param("wid"), &body(&mut r).await?)?)) })),
            (
                M::DELETE,
                h(|r| async move {
                    organize::remove_space(&r.param("wid"))?;
                    Ok(ok())
                }),
            ),
        ],
    );
}

#[cfg(test)]
#[path = "organize_tests.rs"]
mod tests;
