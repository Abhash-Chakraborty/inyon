//! Port of apps/hub/src/claude: the screen reader, transcripts, drafts and delivery, the
//! integration scripts, and the actions and watchers that drive an agent.

pub mod actions;
pub mod chat_cache;
pub mod delivery;
pub mod drafts;
pub mod driving;
pub mod integration;
pub mod integration_sh;
pub mod keep_default;
pub mod screen;
pub mod send_receipts;
pub mod transcript;
pub mod transcript_tail;
