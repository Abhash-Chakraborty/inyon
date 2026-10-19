//! Port of claude/actions.ts (in progress).

use crate::hosts::http_error::HubResult;

pub async fn reconnect_agent(_host_id: &str, _pane_id: &str) -> HubResult<()> {
    Ok(())
}

pub async fn restart_agent(_host_id: &str, _pane_id: &str) -> HubResult<()> {
    Ok(())
}
