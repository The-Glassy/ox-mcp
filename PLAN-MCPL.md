# Open-Xchange inbox events for connectome-host

## MCPL transport

- Extend the existing stdio MCP server and keep its tool registry and feature
  flags. Follow homelab's vendored
  [linear-mcpl](https://github.com/Smartie-Team/homelab/blob/main/ansible/roles/connectome_tenant/files/linear-mcpl/index.mjs)
  handshake. Advertise an opt-in `ox.inbox` feature set through
  `experimental.mcpl` and `mcpl/manifest`. Start delivery after
  `featureSets/update` grants `channels.register` and `channels.incoming`.
- Register an inbound channel for the configured account's INBOX and support
  `channels/list`, `channels/open` and `channels/close` so connectome-host can
  manage the subscription. Use `channels/incoming` requests with a stable
  `messageId` and `eventId` and an `ox:new-mail` tag. The recipe decides whether
  that event wakes the agent. A plain MCP client can still use the tools.
- Emit one event per new message. Include From, Subject, Date (falling back to
  IMAP INTERNALDATE), a short plain-text snippet, and the RFC 5322 Message-ID
  when present. Include the folder and IMAP UID so `email_read` can open it.
  Limit the message data fetched and the snippet length. Treat mail content as
  untrusted, fetch with PEEK on a read-only mailbox, and omit attachments.

## IMAP and durable state

- Use a dedicated ImapFlow connection for INBOX. Reuse ox-mcp's credentials and
  TLS settings and leave tool calls on their existing connections. Use IDLE
  when advertised, refresh it before the server timeout, and use a configurable
  periodic UID scan if IDLE is unavailable or rejected. Serialize scans and use
  UIDs above the watermark, including a catch-up scan after every reconnect.
- Persist UIDVALIDITY, the highest scanned UID, and pending events in a private
  state file per account and mailbox. Write the file atomically, advancing the
  watermark in the same write that queues events. Seed the watermark from
  UIDNEXT minus one on first start so existing mail stays quiet. If UIDVALIDITY
  changes, report the reset and establish a fresh baseline. Retain pending
  events from the old epoch for delivery.
- Derive the delivery IDs from account, mailbox, UIDVALIDITY and UID. Keep events
  queued until the host acknowledges them as accepted or duplicate. Retry with
  the same IDs after a host timeout or process restart. Back off with jitter on
  IMAP errors, reselect the mailbox, and catch up before resuming IDLE. Close the
  watcher on capability revocation, channel closure, or stdio shutdown. Report
  connection and queue status to stderr without message content or credentials.

## Tests

- Use a fake IMAP server to cover startup baseline, IDLE, polling fallback,
  duplicate signals, reconnect catch-up, UIDVALIDITY changes, bounded snippets,
  missing Message-ID and unchanged Seen flags.
- Use a fake stdio host to cover plain MCP tools, capability grants/revocation,
  channel registration, host timeouts, duplicate acknowledgements and restart
  with a pending event. Smoke-test on connectome-host using a disposable mailbox
  and verify that one new message reaches the agent with the expected fields.
