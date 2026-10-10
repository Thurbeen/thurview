-- Thurview, in a pane: one published architecture document, its map and its
-- code anchors, drawn with text and box-drawing cells.
--
-- A proof of concept. The document is a Lua model projected from a sealed
-- thurview revision by examples/terminal-poc/project.ts in the thurview
-- repository; this file only adapts `thurview_poc.view` to the host: the rect,
-- the keys, the animation clock and the theme.
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

local NAME = "thurview"
local loaded, model = pcall(require, "thurview_poc.model")
local st = loaded and view.new(model) or nil

-- The last tree and what it was drawn for. Not being `pure` costs a render per
-- painted frame, so an idle pane hands back the same tree until a key, the
-- rect, the focus or the theme moves; only a playing flow draws afresh.
local cache = {}
local keys_seen = 0

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
  { "esc", "back to the node" },
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
    local w0, h0, f0, theme0 = cache.w, cache.h, cache.focused, cache.theme
    if
      not st.playing
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
        spans[k] = { text = span.text, style = s[span.st] or s.text }
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

  on_action = function(action)
    if action == "thurview.toggle" then
      command("focus", { text = NAME, toggle = true })
      return true
    end
    local key = ACTION_KEY[action]
    if key and st then
      keys_seen = keys_seen + 1
      return view.key(model, st, key) or true
    end
    return false
  end,
}
