-- Thurview, in a pane: one published architecture document, its map and its
-- code anchors, drawn with text and box-drawing cells.
--
-- A proof of concept. The document is a Lua model projected from a sealed
-- thurview revision by examples/terminal-poc/project.ts in the thurview
-- repository; this file only adapts `thurview_poc.view` to the host: the rect,
-- the keys, the mouse, the animation clock and the theme - and hands the
-- view's writes (comments, replies, resolve, the review decision) to
-- bridge.mjs through `run`, which goes through thurview's own threads module.
-- Without the `run` grant the pane still reads and draws; it says why it cannot
-- write rather than pretending to.
--
-- Not `pure`, deliberately. A pure pane only re-renders on the shared animation
-- clock, and the host advances that clock only while a session is working or a
-- command is in flight, so a playing flow would freeze on an idle screen. The
-- render is cheap instead: the document is wrapped and the map laid out once
-- per width, and a frame copies the visible window. The clock is read only
-- while a flow plays, and a hidden pane is not rendered at all.
local theme = require("lib.theme")
local ui = require("lib.ui")
local view = require("thurview_poc.view")
local threads = require("thurview_poc.threads")

local NAME = "thurview"
local loaded, model = pcall(require, "thurview_poc.model")
local st = loaded and view.new(model) or nil

-- The last tree and what it was drawn for. Not being `pure` costs a render per
-- painted frame, so an idle pane hands back the same tree until a key, the
-- rect, the focus or the theme moves; only a playing flow draws afresh.
local cache = {}
local keys_seen = 0

-- The bridge: one short-lived process per write, and a listing refreshed
-- every LIST_EVERY seconds while the pane is drawn. Nothing runs per frame,
-- and a hidden pane is not drawn.
local LIST, LIST_EVERY = "thurview.threads", 30
local WRITE_OPTS = { machine = "local", timeout = 30 }
local writes, write_seq, last_list = {}, 0, nil
-- When the next listing is due, on the render clock. Asked on a schedule of
-- our own: re-asking a run on every frame runs it again and again.
local list_due = nil

local function q(s)
  return "'" .. tostring(s):gsub("'", "'\\''") .. "'"
end

local function bridge(args)
  local out = { "THURVIEW_HOME=" .. q(model.home), "node", q(model.bridge) }
  for _, a in ipairs(args) do
    out[#out + 1] = q(a)
  end
  return table.concat(out, " ")
end

--- Why the pane cannot write, or nil when it can.
local function readonly()
  if not (model.review and model.home and model.bridge) then
    return "read-only: this model came from no thurview store"
  end
  if not run then
    return "read-only: grant run to thurview in Ctrl+, → ] (t) to comment"
  end
end

--- Hand the view's writes to the bridge, each as its own run.
local function flush()
  if not run or readonly() then
    view.take_outbox(st)
    return
  end
  for _, w in ipairs(view.take_outbox(st)) do
    local args
    if w[1] == "create" then
      args = { "create", model.review, w[2], threads.hex(w[3]), w[4], threads.hex(w[5]) }
    elseif w[1] == "reply" then
      args = { "reply", model.review, w[2], threads.hex(w[3]) }
    elseif w[1] == "status" then
      args = { "status", model.review, w[2], w[3] }
    else
      args = { "submit", model.review, w[2], threads.hex(w[3] or "") }
    end
    write_seq = write_seq + 1
    local pending = { key = "thurview.write." .. write_seq, cmd = bridge(args) }
    run(pending.key, pending.cmd, WRITE_OPTS)
    writes[#writes + 1] = pending
  end
end

--- Read what the bridge answered; true when it changed what the view shows.
local function collect(now)
  if not run or readonly() then
    return false
  end
  local changed = false
  if not list_due or now >= list_due then
    run(
      LIST,
      bridge({ "list", model.review }),
      { machine = "local", timeout = 30, refresh = list_due ~= nil }
    )
    list_due = now + LIST_EVERY
  end
  local runs = thurbox.runs or {}
  local listed = runs[LIST]
  if listed and listed.state == "done" and listed.stdout and listed.stdout ~= last_list then
    last_list = listed.stdout
    view.set_threads(st, threads.parse(listed.stdout))
    changed = true
  end
  local i = 1
  while writes[i] do
    local answer = runs[writes[i].key]
    if answer and answer.state ~= "pending" then
      if answer.stdout and answer.stdout ~= "" then
        -- Every answer is the review's whole thread state, so it replaces the listing.
        view.set_threads(st, threads.parse(answer.stdout))
      end
      if answer.state == "failed" and not (answer.stdout or ""):match("^E\t") then
        st.notice = "thurview: " .. (answer.error or answer.stderr or "the write failed")
      end
      table.remove(writes, i)
      changed = true
    else
      i = i + 1
    end
  end
  return changed or #writes > 0
end

--- The view's semantic styles, as this palette's roles. Rebuilt only when the
--- theme group is a new table, which is when its roles moved.
local styles, styles_for
local function palette()
  if styles and rawequal(styles_for, thurbox.theme) then
    return styles
  end
  local r = theme.role
  local text, muted, accent = r("text_primary"), r("text_muted"), r("accent")
  local bright, second = r("accent_bright"), r("text_secondary")
  local flow = { fg = r("status_working"), bold = true }
  styles = {
    text = { fg = text },
    muted = { fg = muted },
    h1 = { fg = bright, bold = true },
    h2 = { fg = accent, bold = true },
    h3 = { fg = second, bold = true },
    strong = { fg = text, bold = true },
    em = { fg = second, italic = true },
    code = { fg = r("branch_name") },
    link = { fg = accent, underline = true },
    link_sel = { fg = r("selection_fg"), bg = r("selection_bg"), bold = true },
    rule = { fg = r("border_unfocused") },
    quote = { fg = muted },
    box = { fg = second },
    box_added = { fg = r("diff_added") },
    box_added_tag = { fg = r("diff_added"), bold = true },
    box_changed = { fg = r("status_done") },
    box_changed_tag = { fg = r("status_done"), bold = true },
    kind = { fg = muted },
    label = { fg = text, bold = true },
    line = { fg = muted },
    arrow = { fg = second },
    edge_label = { fg = second, italic = true },
    sel = { fg = bright, bold = true },
    sel_edge = { fg = accent },
    flow = flow,
    loc = { fg = r("branch_name") },
    gutter = { fg = muted },
    tok_keyword = { fg = accent },
    tok_string = { fg = r("diff_added") },
    tok_comment = { fg = muted, italic = true },
    tok_function = { fg = bright },
    tok_number = { fg = r("status_working") },
    tok_type = { fg = r("role_name") },
    caption = { fg = second },
    focus = { fg = bright, bold = true },
    sep = { fg = r("border_unfocused") },
    sel_block = { fg = bright, bold = true },
    thread = { fg = accent },
    thread_sel = { fg = r("selection_fg"), bg = r("selection_bg") },
    button = { fg = second, underline = true },
    button_on = { fg = r("selection_fg"), bg = r("selection_bg"), bold = true },
    status = { fg = r("keybind_hint") },
  }
  styles_for = thurbox.theme
  return styles
end

-- Every key the pane answers, declared so help lists them and they can be rebound.
local KEYS = {
  { "j", "down / next node" },
  { "k", "up / previous node" },
  { "down", "down / next node" },
  { "up", "up / previous node" },
  { "pagedown", "page down" },
  { "pageup", "page up" },
  { "g", "top of the document" },
  { "G", "end of the document" },
  { "]", "next section" },
  { "[", "previous section" },
  { "n", "next code anchor" },
  { "N", "previous code anchor" },
  { "enter", "open the anchor's code" },
  { "tab", "document, map, inspector" },
  { "space", "play or pause the flow" },
  { "s", "next sequence" },
  { ".", "flow step forward" },
  { ",", "flow step back" },
  { "left", "pan the map left" },
  { "right", "pan the map right" },
  { "h", "pan the map left" },
  { "l", "pan the map right" },
  { "J", "pan the map down" },
  { "K", "pan the map up" },
  { "esc", "back, or cancel the comment" },
  { "c", "comment on the block or part" },
  { "C", "comment on the whole document" },
  { "R", "submit the review" },
  { "t", "next thread" },
  { "T", "previous thread" },
  { "r", "reply to the thread" },
  { "x", "resolve or reopen the thread" },
}
local keys = {
  {
    key = "f3",
    action = "thurview.toggle",
    desc = "open or leave the thurview document",
    scope = "global",
    group = "UI",
  },
}
local ACTION_KEY = {}
for _, k in ipairs(KEYS) do
  local action = "thurview.key." .. k[1]
  ACTION_KEY[action] = k[1]
  keys[#keys + 1] = { key = k[1], action = action, desc = k[2], group = "Thurview" }
end

return {
  name = NAME,
  slot = "center",
  slot_mode = "switch",
  order = 30,
  focusable = true,
  pure = false,
  keys = keys,
  pills = { { action = "thurview.toggle", label = "Thurview", priority = 5 } },
  -- Only for writing: bridge.mjs, one process per comment, reply, resolve or
  -- submit, and a listing every LIST_EVERY seconds. Untrusted, the pane
  -- reads and draws and says it cannot write.
  capabilities = { "run" },
  -- The keys' and the mouse's operations by name, with typed arguments, so an
  -- agent drives the pane with `thurbox-cli ui action` rather than keystrokes.
  actions = {
    {
      name = "thurview.select",
      desc = "select a block, part, anchor or thread",
      effect = "ui-write",
      args = { { name = "target", kind = "string", required = true } },
    },
    {
      name = "thurview.comment",
      desc = "comment on a block, a part or the whole document",
      effect = "kernel-write",
      args = {
        { name = "body", kind = "string", required = true },
        { name = "target", kind = "string" },
        { name = "mode", kind = "string" },
      },
    },
    {
      name = "thurview.reply",
      desc = "reply to a thread",
      effect = "kernel-write",
      args = {
        { name = "thread", kind = "string", required = true },
        { name = "body", kind = "string", required = true },
      },
    },
    {
      name = "thurview.resolve",
      desc = "resolve or reopen a thread",
      effect = "kernel-write",
      args = {
        { name = "thread", kind = "string", required = true },
        { name = "status", kind = "string" },
      },
    },
    {
      name = "thurview.submit",
      desc = "submit the review: approve, request-changes or close",
      effect = "kernel-write",
      args = {
        { name = "decision", kind = "string", required = true },
        { name = "body", kind = "string" },
      },
    },
  },
  commands = { { action = "thurview.toggle", desc = "open or leave the thurview document" } },

  render = function(ctx)
    local w, h = math.max(1, (ctx.width or 0) - 2), math.max(2, (ctx.height or 0) - 2)
    if not st then
      return ui.panel({
        title = "Thurview",
        focused = ctx.focused,
        body = {
          type = "text",
          text = {
            {
              text = " No document installed: run install.sh from thurview's examples/terminal-poc.",
              style = { fg = theme.muted },
            },
          },
        },
      })
    end
    st.readonly = readonly()
    local fresh = collect(ctx.elapsed or 0)
    local w0, h0, f0, theme0 = cache.w, cache.h, cache.focused, cache.theme
    if
      not st.playing
      and not fresh
      and cache.tree
      and w0 == w
      and h0 == h
      and f0 == ctx.focused
      and cache.keys == keys_seen
      and rawequal(theme0, thurbox.theme)
    then
      return cache.tree
    end
    local frame = view.render(model, st, {
      width = w,
      height = h,
      -- Read only while a flow plays: the clock is the one input that moves on its own.
      elapsed = st.playing and ctx.elapsed or 0,
    })
    local s = palette()
    local lines = {}
    for i, row in ipairs(frame.lines) do
      local spans = {}
      for k, span in ipairs(row) do
        -- The id makes the run a click target: the host hands it back in on_click.
        spans[k] = { text = span.text, style = s[span.st] or s.text, id = span.id }
      end
      lines[i] = spans
    end
    ---@type thurbox.TextNode
    local body = { type = "text", text = lines }
    cache = {
      w = w,
      h = h,
      focused = ctx.focused,
      keys = keys_seen,
      theme = thurbox.theme,
      tree = ui.panel({
        title = "Thurview · " .. model.title .. " · r" .. model.revision,
        focused = ctx.focused,
        body = body,
      }),
    }
    return cache.tree
  end,

  ui_state = function()
    return st and view.public_state(model, st) or { installed = false }
  end,

  on_action = function(action, args)
    if action == "thurview.toggle" then
      command("focus", { text = NAME, toggle = true })
      return true
    end
    local op = action:match("^thurview%.(%a+)$")
    if op and st then
      keys_seen = keys_seen + 1
      st.readonly = readonly()
      local used = view.act(model, st, op, args)
      flush()
      return used
    end
    local key = ACTION_KEY[action]
    if key and st then
      keys_seen = keys_seen + 1
      -- While composing, a declared key is a character like any other.
      local char = utf8.len(key) == 1 and key or nil
      -- A key the view does not use falls through, so Esc still goes back.
      local used = view.key(model, st, key, nil, char)
      flush()
      return used
    end
    return false
  end,

  -- Keys nobody declared reach here: the composer's letters, Backspace.
  on_key = function(key)
    if not st or key.ctrl or key.alt or key.cmd then
      return false
    end
    if not st.compose then
      return false
    end
    keys_seen = keys_seen + 1
    local used = view.key(model, st, key.key, nil, key.char)
    flush()
    return used
  end,

  on_click = function(hit)
    if not st then
      return false
    end
    keys_seen = keys_seen + 1
    local used = view.click(model, st, hit.id, hit.clicks)
    flush()
    return used
  end,

  -- The wheel scrolls what is under the pointer; the frame takes a cell each side.
  on_scroll = function(wheel)
    if not st then
      return false
    end
    keys_seen = keys_seen + 1
    return view.scroll(model, st, wheel.up, (wheel.x or 1) - 1, (wheel.y or 1) - 1)
  end,
}
