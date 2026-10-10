-- The thurview document as a terminal view: the prose, the architecture map and
-- an inspector, laid out for the rect it is handed.
--
-- Host-independent on purpose. Nothing here reads a thurbox global: the pane
-- hands in the size and the animation clock, and gets back rows of spans whose
-- `st` names a semantic style ("h2", "link", "flow"...) that the pane maps onto
-- theme roles. That keeps every behaviour testable in a plain Lua 5.4, which is
-- the interpreter the host embeds.
--
--   local st = view.new(model)
--   view.key(model, st, "j")                                   -> handled?
--   view.render(model, st, { width =, height =, elapsed = })   -> { lines, status }
local D = require("thurview_poc.diagram")

local M = {}

--- Seconds one message of a sequence stays highlighted.
M.STEP = 1.2
--- A gap between two renders longer than this means the pane was not drawn:
--- hidden, or covered. Visible, the host repaints at least four times a second.
M.HIDDEN_GAP = 2.0
--- From this many columns the document, the map and the inspector share the
--- screen; below it they take turns.
M.WIDE = 100

local width, cut = D.width, D.cut
local FOCI = { "doc", "map", "inspect" }

local function pad(spans, w)
  local used = 0
  for _, s in ipairs(spans) do
    used = used + width(s.text)
  end
  if used < w then
    spans[#spans + 1] = { text = string.rep(" ", w - used), st = "text" }
  end
  return spans
end

--- Spans cut to exactly `w` columns.
local function clip(spans, w)
  local out, used = {}, 0
  for _, s in ipairs(spans) do
    local n = width(s.text)
    if used + n <= w then
      out[#out + 1] = s
      used = used + n
    else
      local rest = w - used
      if rest > 0 then
        out[#out + 1] = { text = cut(s.text, rest), st = s.st, link = s.link }
      end
      break
    end
  end
  return pad(out, w)
end

local function clamp(v, lo, hi)
  if v < lo then
    return lo
  end
  if v > hi then
    return hi
  end
  return v
end

local function sequences(model)
  local out = {}
  for _, b in ipairs(model.blocks) do
    if b.t == "sequence" then
      out[#out + 1] = b
    end
  end
  return out
end

local function node_label(model, id)
  for _, n in ipairs(model.map.nodes) do
    if n.id == id then
      return n.label
    end
  end
  return id
end

-- ---------------------------------------------------------------------------
-- The document, wrapped once per width.

local function run_style(r)
  if r.anchor then
    return "link"
  elseif r.code then
    return "code"
  elseif r.strong then
    return "strong"
  elseif r.em then
    return "em"
  end
  return "text"
end

--- Runs filled into lines of `w` columns; `first`/`rest` are the line prefixes.
--- An anchor run is registered in `links`, with the line it starts on counted
--- from `line_base`.
local function wrap(runs, w, first, rest, links, line_base, base_st)
  local words = {}
  for _, r in ipairs(runs) do
    local st = base_st or run_style(r)
    local link
    if r.anchor then
      links[#links + 1] = { anchor = r.anchor, text = r.text }
      link = #links
    end
    for space, word in r.text:gmatch("(%s*)(%S+)") do
      words[#words + 1] = { text = word, st = st, link = link, space = space ~= "" }
    end
    if r.text:match("%s$") and words[#words] then
      words[#words].trail = true
    end
  end
  local lines, line, used, lead = {}, nil, 0, 0
  local function open(prefix)
    line = { { text = prefix.text, st = prefix.st } }
    used = width(prefix.text)
    lead = used
    lines[#lines + 1] = line
  end
  open(first)
  local prev
  for _, wd in ipairs(words) do
    local gap = (prev and (wd.space or prev.trail)) and 1 or 0
    if used + gap + width(wd.text) > w and used > lead then
      open(rest)
      gap = 0
    end
    if gap == 1 then
      local joined = prev.link and prev.link == wd.link
      line[#line + 1] =
        { text = " ", st = joined and wd.st or "text", link = joined and wd.link or nil }
      used = used + 1
    end
    -- A word wider than the whole line is split, never pushed off the edge.
    local text = wd.text
    while used + width(text) > w and w - used > 0 do
      local head = text:sub(1, (utf8.offset(text, w - used + 1) or (#text + 1)) - 1)
      line[#line + 1] = { text = head, st = wd.st, link = wd.link }
      text = text:sub(#head + 1)
      open(rest)
    end
    line[#line + 1] = { text = text, st = wd.st, link = wd.link }
    used = used + width(text)
    if wd.link and not links[wd.link].line then
      links[wd.link].line = line_base + #lines
    end
    prev = wd
  end
  return lines
end

local doc_cache = {}

local function build_doc(model, w)
  if doc_cache.model == model and doc_cache.w == w then
    return doc_cache
  end
  local lines, links, headings, msg_line = {}, {}, {}, {}
  local function add(spans)
    lines[#lines + 1] = spans
  end
  local function blank()
    if #lines > 0 and #lines[#lines] > 0 then
      add({})
    end
  end
  local function add_wrapped(runs, first, rest, base_st)
    -- One column short of the edge, so prose never touches the separator.
    for _, l in ipairs(wrap(runs, math.max(8, w - 1), first, rest, links, #lines, base_st)) do
      add(l)
    end
  end
  local seq_index = 0
  for bi, b in ipairs(model.blocks) do
    local prev = model.blocks[bi - 1]
    if not (prev and prev.t == "item" and b.t == "item") then
      blank()
    end
    if b.t == "heading" then
      headings[#headings + 1] = #lines + 1
      if b.level == 1 then
        add_wrapped({ { text = b.text } }, { text = "", st = "h1" }, { text = "", st = "h1" }, "h1")
        add({ { text = string.rep("━", math.min(w, width(b.text))), st = "h1" } })
      elseif b.level == 2 then
        local t = cut(b.text, math.max(1, w - 4))
        add({
          { text = "── ", st = "rule" },
          { text = t, st = "h2" },
          { text = " " .. string.rep("─", math.max(0, w - width(t) - 4)), st = "rule" },
        })
      else
        add_wrapped(
          { { text = b.text } },
          { text = "▸ ", st = "h3" },
          { text = "  ", st = "h3" },
          "h3"
        )
      end
    elseif b.t == "para" then
      local p = b.quote and "▌ " or ""
      add_wrapped(b.runs, { text = p, st = "quote" }, { text = p, st = "quote" })
    elseif b.t == "item" then
      -- An empty marker continues the item above, so its text hangs under that item's.
      local marker = string.rep("  ", b.depth) .. (b.marker == "" and " " or b.marker) .. " "
      add_wrapped(
        b.runs,
        { text = marker, st = "muted" },
        { text = string.rep(" ", width(marker)), st = "text" }
      )
    elseif b.t == "table" then
      local cols, total = {}, 0
      for _, row in ipairs(b.rows) do
        for c, cell in ipairs(row) do
          cols[c] = math.max(cols[c] or 0, width(cell))
        end
      end
      for _, c in ipairs(cols) do
        total = total + c + 3
      end
      if total - 3 <= w then
        for r, row in ipairs(b.rows) do
          local spans = {}
          for c, cell in ipairs(row) do
            if c > 1 then
              spans[#spans + 1] = { text = " │ ", st = "rule" }
            end
            spans[#spans + 1] = {
              text = cell .. string.rep(" ", cols[c] - width(cell)),
              st = r == 1 and "strong" or "text",
            }
          end
          add(spans)
          if r == 1 then
            local parts = {}
            for c, n in ipairs(cols) do
              parts[c] = string.rep("─", n)
            end
            add({ { text = table.concat(parts, "─┼─"), st = "rule" } })
          end
        end
      else
        -- Too wide to draw as a grid: one block of "header: value" per row.
        for r = 2, #b.rows do
          for c, cell in ipairs(b.rows[r]) do
            add_wrapped(
              { { text = cell } },
              { text = (b.rows[1][c] or "") .. ": ", st = "strong" },
              { text = "  ", st = "text" },
              "text"
            )
          end
          if r < #b.rows then
            add({})
          end
        end
      end
    elseif b.t == "code" then
      for _, l in ipairs(b.lines) do
        add({ { text = "  " .. cut(l, w - 2), st = "code" } })
      end
    elseif b.t == "sequence" then
      seq_index = seq_index + 1
      add_wrapped(
        { { text = b.label } },
        { text = "⇄ ", st = "h3" },
        { text = "  ", st = "h3" },
        "h3"
      )
      add({ { text = "  space plays it on the map", st = "muted" } })
      msg_line[seq_index] = {}
      for j, m in ipairs(b.messages) do
        local runs = {
          {
            text = node_label(model, m.from) .. " → " .. node_label(model, m.to) .. ": ",
            strong = true,
          },
          m.anchor and { text = m.label, anchor = m.anchor } or { text = m.label },
        }
        local first = #lines + 1
        add_wrapped(
          runs,
          { text = string.format("%2d. ", j), st = "muted" },
          { text = "    ", st = "text" }
        )
        msg_line[seq_index][j] = { first = first, last = #lines }
      end
    elseif b.t == "flow" then
      add_wrapped(
        { { text = b.label } },
        { text = "◇ ", st = "h3" },
        { text = "  ", st = "h3" },
        "h3"
      )
      local label_of = {}
      for _, s in ipairs(b.steps) do
        label_of[s.id] = s.label
      end
      for _, s in ipairs(b.steps) do
        local runs = { s.anchor and { text = s.label, anchor = s.anchor } or { text = s.label } }
        add_wrapped(
          runs,
          { text = s.decision and "  ◆ " or "  ○ ", st = "muted" },
          { text = "    ", st = "text" }
        )
        for _, e in ipairs(b.edges) do
          if e.from == s.id then
            local to = (e.case and (e.case .. " → ") or "→ ") .. (label_of[e.to] or e.to)
            add_wrapped(
              { { text = to } },
              { text = "      ", st = "muted" },
              { text = "        ", st = "muted" },
              "muted"
            )
          end
        end
      end
    elseif b.t == "peek" then
      local a = model.anchors[b.anchor]
      add_wrapped(
        { { text = (a and a.title) or b.anchor, anchor = b.anchor } },
        { text = "▸ peek: ", st = "muted" },
        { text = "  ", st = "text" }
      )
    elseif b.t == "rule" then
      add({ { text = string.rep("─", w), st = "rule" } })
    else
      add({ { text = "[" .. b.what .. ": drawn in the browser only]", st = "muted" } })
    end
  end
  doc_cache =
    { model = model, w = w, lines = lines, links = links, headings = headings, msg_line = msg_line }
  return doc_cache
end

-- ---------------------------------------------------------------------------
-- The map, laid out once per box width.

local map_cache = {}

local function box_max_for(w)
  return w < 60 and 18 or 24
end

local function layout(model, map_w)
  local box_max = box_max_for(map_w)
  if map_cache.model ~= model or map_cache.box_max ~= box_max then
    map_cache =
      { model = model, box_max = box_max, layout = D.layout(model.map, { box_max = box_max }) }
  end
  return map_cache.layout
end

-- ---------------------------------------------------------------------------
-- State and geometry.

function M.new(_)
  return {
    focus = "doc",
    scroll = 0,
    link = nil,
    node = 1,
    pan_x = 0,
    pan_y = 0,
    seq = 1,
    step = 1,
    playing = false,
    -- Whether a flow has been started, so its step stays on show once paused.
    shown = false,
    inspect = "node",
    anchor = nil,
    peek = 0,
    -- The last rect drawn, for the keys: the host passes no rect to a key.
    w = 80,
    h = 24,
  }
end

--- The regions for a rect: where the document, the map and the inspector go.
local function geometry(w, h)
  local body = math.max(1, h - 1)
  if w >= M.WIDE then
    local doc_w = math.floor(w * 0.45)
    local right = w - doc_w - 1
    local insp = math.max(8, math.min(18, math.floor(body * 0.42)))
    return {
      wide = true,
      doc = { w = doc_w, h = body },
      map = { w = right, h = body - insp },
      inspect = { w = right, h = insp },
    }
  end
  return {
    wide = false,
    doc = { w = w, h = body },
    map = { w = w, h = body },
    inspect = { w = w, h = body },
  }
end

local function map_layout(model, st)
  local g = geometry(st.w, st.h)
  return layout(model, g.map.w), g.map.w, g.map.h - 1
end

--- Pan just enough that a rect of the map is inside the viewport.
local function reveal(st, L, vw, vh, x1, y1, x2, y2)
  if x1 <= st.pan_x or x2 > st.pan_x + vw then
    st.pan_x = clamp(math.floor((x1 + x2) / 2 - vw / 2), 0, math.max(0, L.w - vw))
  end
  if y1 <= st.pan_y or y2 > st.pan_y + vh then
    st.pan_y = clamp(math.floor((y1 + y2) / 2 - vh / 2), 0, math.max(0, L.h - vh))
  end
end

local function reveal_node(model, st)
  local L, vw, vh = map_layout(model, st)
  local n = L.nodes[L.order[st.node]]
  if n then
    reveal(st, L, vw, vh, n.x, n.y, n.x + n.w, n.y + n.h)
  end
end

local function active_message(model, st)
  local seq = sequences(model)[st.seq]
  return seq, seq and seq.messages[st.step]
end

local function flow_edge(L, m)
  return L.edge_index[m.from .. ">" .. m.to] or L.edge_index[m.to .. ">" .. m.from]
end

local function reveal_flow(model, st)
  local _, m = active_message(model, st)
  if not m then
    return
  end
  local L, vw, vh = map_layout(model, st)
  local k = flow_edge(L, m)
  if k then
    local e = L.edges[k]
    reveal(st, L, vw, vh, e.x1, e.y1, e.x2, e.y2)
  else
    local n = L.nodes[m.to] or L.nodes[m.from]
    if n then
      reveal(st, L, vw, vh, n.x, n.y, n.x + n.w, n.y + n.h)
    end
  end
end

-- ---------------------------------------------------------------------------
-- Keys.

local function select_link(model, st, idx)
  local g = geometry(st.w, st.h)
  local doc = build_doc(model, g.doc.w)
  local link = doc.links[idx]
  if not link then
    return false
  end
  st.link, st.anchor, st.inspect, st.peek = idx, link.anchor, "anchor", 0
  local vh = g.doc.h - 1
  if link.line <= st.scroll or link.line > st.scroll + vh then
    st.scroll = math.max(0, link.line - 3)
  end
  -- The map follows the prose: the anchor's own part is selected and shown.
  local a = model.anchors[link.anchor]
  local L = map_layout(model, st)
  for i, id in ipairs(L.order) do
    if a and id == a.map then
      st.node = i
      reveal_node(model, st)
    end
  end
  return true
end

local function doc_key(model, st, key)
  local g = geometry(st.w, st.h)
  local doc = build_doc(model, g.doc.w)
  local vh = g.doc.h - 1
  local max = math.max(0, #doc.lines - vh)
  if key == "j" or key == "down" then
    st.scroll = clamp(st.scroll + 1, 0, max)
  elseif key == "k" or key == "up" then
    st.scroll = clamp(st.scroll - 1, 0, max)
  elseif key == "pagedown" then
    st.scroll = clamp(st.scroll + vh - 2, 0, max)
  elseif key == "pageup" then
    st.scroll = clamp(st.scroll - vh + 2, 0, max)
  elseif key == "g" or key == "home" then
    st.scroll = 0
  elseif key == "G" or key == "end" then
    st.scroll = max
  elseif key == "]" then
    for _, line in ipairs(doc.headings) do
      if line - 1 > st.scroll then
        st.scroll = clamp(line - 1, 0, max)
        break
      end
    end
  elseif key == "[" then
    for i = #doc.headings, 1, -1 do
      if doc.headings[i] - 1 < st.scroll then
        st.scroll = clamp(doc.headings[i] - 1, 0, max)
        break
      end
    end
  elseif key == "n" or key == "N" then
    local cur = st.link and doc.links[st.link]
    -- From the selection while it is on screen, otherwise from the screen's edge.
    local on_screen = cur and cur.line > st.scroll and cur.line <= st.scroll + vh
    if key == "n" then
      for i, l in ipairs(doc.links) do
        if (on_screen and i > st.link) or (not on_screen and l.line > st.scroll) then
          return select_link(model, st, i)
        end
      end
    else
      for i = #doc.links, 1, -1 do
        local l = doc.links[i]
        if (on_screen and i < st.link) or (not on_screen and l.line <= st.scroll + vh) then
          return select_link(model, st, i)
        end
      end
    end
  elseif key == "enter" and st.link then
    st.focus = "inspect"
  else
    return false
  end
  return true
end

local function map_key(model, st, key)
  local L, vw, vh = map_layout(model, st)
  if #L.order == 0 then
    return false
  end
  if key == "j" or key == "down" then
    st.node = st.node % #L.order + 1
    st.inspect = "node"
    reveal_node(model, st)
  elseif key == "k" or key == "up" then
    st.node = (st.node - 2) % #L.order + 1
    st.inspect = "node"
    reveal_node(model, st)
  elseif key == "left" or key == "h" then
    st.pan_x = clamp(st.pan_x - 8, 0, math.max(0, L.w - vw))
  elseif key == "right" or key == "l" then
    st.pan_x = clamp(st.pan_x + 8, 0, math.max(0, L.w - vw))
  elseif key == "K" or key == "pageup" then
    st.pan_y = clamp(st.pan_y - 4, 0, math.max(0, L.h - vh))
  elseif key == "J" or key == "pagedown" then
    st.pan_y = clamp(st.pan_y + 4, 0, math.max(0, L.h - vh))
  elseif key == "enter" then
    for _, node in ipairs(model.map.nodes) do
      if node.id == L.order[st.node] and node.anchor and model.anchors[node.anchor] then
        st.anchor, st.inspect, st.peek, st.focus = node.anchor, "anchor", 0, "inspect"
      end
    end
  else
    return false
  end
  return true
end

local function inspect_key(st, key)
  if key == "j" or key == "down" then
    st.peek = st.peek + 1
  elseif key == "k" or key == "up" then
    st.peek = math.max(0, st.peek - 1)
  elseif key == "esc" or key == "backspace" then
    st.inspect = "node"
  else
    return false
  end
  return true
end

--- One key. Returns whether the view used it, so the host can pass the rest on.
function M.key(model, st, key, ctx)
  if ctx and ctx.width then
    st.w, st.h = ctx.width, ctx.height
  end
  local seqs = sequences(model)
  local seq = seqs[st.seq]
  if key == "tab" or key == "backtab" then
    local i = 1
    for k, f in ipairs(FOCI) do
      if f == st.focus then
        i = k
      end
    end
    st.focus = FOCI[(i + (key == "tab" and 0 or -2)) % #FOCI + 1]
    return true
  elseif key == "space" or key == " " then
    if seq and st.playing then
      st.playing, st.t_anchor = false, nil
    elseif seq then
      if st.step >= #seq.messages then
        st.step = 1
      end
      st.playing, st.shown, st.step0, st.t_anchor = true, true, st.step, nil
      reveal_flow(model, st)
    end
    return true
  elseif key == "s" then
    if #seqs > 0 then
      st.seq = st.seq % #seqs + 1
      st.step, st.playing, st.shown = 1, false, true
      reveal_flow(model, st)
    end
    return true
  elseif key == "." or key == "," then
    if seq then
      st.playing, st.shown, st.t_anchor = false, true, nil
      st.step = clamp(st.step + (key == "." and 1 or -1), 1, #seq.messages)
      reveal_flow(model, st)
    end
    return true
  end
  if st.focus == "doc" then
    return doc_key(model, st, key)
  elseif st.focus == "map" then
    return map_key(model, st, key)
  end
  return inspect_key(st, key)
end

-- ---------------------------------------------------------------------------
-- Rendering.

--- Move the animation on from the clock. Only called while playing, so a
--- paused or finished flow never reads `elapsed`.
local function advance(model, st, elapsed)
  local seq = sequences(model)[st.seq]
  if not seq then
    st.playing = false
    return
  end
  if not st.t_anchor then
    st.t_anchor, st.t_last = elapsed, elapsed
  end
  if elapsed - st.t_last > M.HIDDEN_GAP then
    -- Not drawn for a while: carry on from where the reader last saw it.
    st.t_anchor = st.t_anchor + (elapsed - st.t_last)
  end
  st.t_last = elapsed
  local step = st.step0 + math.floor((elapsed - st.t_anchor) / M.STEP)
  if step >= #seq.messages then
    step, st.playing, st.t_anchor = #seq.messages, false, nil
  end
  if step ~= st.step then
    st.step = step
    reveal_flow(model, st)
  end
end

local function caption(text, w, focused)
  return clip({ { text = " " .. text .. " ", st = focused and "focus" or "caption" } }, w)
end

local function render_doc(model, st, w, h, focused)
  local doc = build_doc(model, w)
  local max = math.max(0, #doc.lines - (h - 1))
  st.scroll = clamp(st.scroll, 0, max)
  local pct = max == 0 and 100 or math.floor(st.scroll * 100 / max)
  local out = { caption("document · " .. pct .. "%", w, focused) }
  local msgs = doc.msg_line[st.seq]
  local lit = {}
  if st.shown and msgs and msgs[st.step] then
    for l = msgs[st.step].first, msgs[st.step].last do
      lit[l] = true
    end
  end
  for r = 1, h - 1 do
    local i = st.scroll + r
    local spans = {}
    for k, s in ipairs(doc.lines[i] or {}) do
      local style = s.st
      if s.link and s.link == st.link then
        style = "link_sel"
      elseif lit[i] and style ~= "muted" then
        style = "flow"
      end
      spans[k] = { text = s.text, st = style }
    end
    out[#out + 1] = clip(spans, w)
  end
  return out
end

local function render_map(model, st, w, h, focused)
  local L = layout(model, w)
  local vw, vh = w, h - 1
  st.pan_x = clamp(st.pan_x, 0, math.max(0, L.w - vw))
  st.pan_y = clamp(st.pan_y, 0, math.max(0, L.h - vh))
  local selected = L.order[st.node]
  local seq, m = active_message(model, st)
  local lit_edge, lit_nodes = nil, {}
  if st.shown and m then
    lit_edge = flow_edge(L, m)
    lit_nodes[m.from], lit_nodes[m.to] = true, true
  end
  local sel_edges = {}
  for k, e in ipairs(L.edges) do
    if e.from == selected or e.to == selected then
      sel_edges[k] = true
    end
  end
  local text
  if st.shown and m then
    text = (st.playing and "▶ " or "⏸ ") .. st.step .. "/" .. #seq.messages .. " " .. m.label
  else
    text = "map"
    local more = (st.pan_x > 0 and "◂" or "")
      .. (st.pan_x + vw < L.w and "▸" or "")
      .. (st.pan_y > 0 and "▴" or "")
      .. (st.pan_y + vh < L.h and "▾" or "")
    if more ~= "" then
      text = text .. " · more " .. more
    end
    if L.unlabelled > 0 then
      text = text .. " · " .. L.unlabelled .. " label(s) only in the inspector"
    end
  end
  local out = { caption(text, w, focused) }
  for r = 1, vh do
    local row = L.cells[st.pan_y + r] or {}
    local spans, cur = {}, nil
    for c = 1, vw do
      local cell = row[st.pan_x + c]
      local ch, style = " ", "text"
      if cell and cell.ch then
        ch, style = cell.ch, cell.cls
        if cell.node and lit_nodes[cell.node] then
          style = "flow"
        elseif cell.node and cell.node == selected then
          style = "sel"
        end
        if cell.edges and style ~= "flow" then
          if lit_edge and cell.edges[lit_edge] then
            style = "flow"
          elseif style ~= "sel" then
            for k in pairs(cell.edges) do
              if sel_edges[k] then
                style = "sel_edge"
              end
            end
          end
        end
      end
      if cur and cur.st == style then
        cur.text = cur.text .. ch
      else
        cur = { text = ch, st = style }
        spans[#spans + 1] = cur
      end
    end
    out[#out + 1] = spans
  end
  return out
end

local function where(model, a)
  return a.file and (a.file .. ":" .. a.from .. "-" .. a.to .. " @ " .. model.commit:sub(1, 7))
end

local function render_inspect(model, st, w, h, focused)
  local L = map_layout(model, st)
  local lines = {}
  local function add(spans)
    lines[#lines + 1] = spans
  end
  local function para(text, style, first)
    for _, l in
      ipairs(
        wrap(
          { { text = text } },
          w - 1,
          { text = first or " ", st = style },
          { text = "   ", st = style },
          {},
          0,
          style
        )
      )
    do
      add(l)
    end
  end
  local title
  local a = st.inspect == "anchor" and st.anchor and model.anchors[st.anchor]
  if a then
    title = "anchor · " .. st.anchor
    para(a.title, "strong", " ◆ ")
    if a.file then
      add({ { text = " " .. where(model, a), st = "loc" } })
    end
    if a.detail then
      para(a.detail, "muted")
    end
    add({})
    if #a.lines == 0 then
      add({ { text = " no code peek on this anchor", st = "muted" } })
    end
    local digits = #tostring(a.to or 0)
    st.peek = clamp(st.peek, 0, math.max(0, #a.lines - 1))
    for i = 1 + st.peek, #a.lines do
      local spans = {
        { text = string.format(" %" .. digits .. "d │ ", (a.from or 1) + i - 1), st = "gutter" },
      }
      for _, t in ipairs(a.lines[i]) do
        spans[#spans + 1] = { text = t.text, st = "tok_" .. t.tok }
      end
      add(spans)
    end
  else
    local id = L.order[st.node]
    local node
    for _, n in ipairs(model.map.nodes) do
      if n.id == id then
        node = n
      end
    end
    title = "node · " .. (id or "none")
    if node then
      local status = node.status == "added" and " · new in this design"
        or node.status == "changed" and " · changed by this design"
        or ""
      add({
        { text = " ▣ ", st = "muted" },
        { text = node.label, st = "strong" },
        { text = "  " .. node.kind .. status, st = "muted" },
      })
      if node.description then
        para(node.description, "text")
      end
      if L.parent_of[id] then
        add({ { text = " in " .. node_label(model, L.parent_of[id]), st = "muted" } })
      end
      local na = node.anchor and model.anchors[node.anchor]
      if na then
        para(na.title, "text", " ◆ ")
        if na.file then
          add({ { text = "   " .. where(model, na) .. " · enter", st = "loc" } })
        end
      end
      add({})
      add({ { text = " connections", st = "h3" } })
      for _, e in ipairs(model.map.edges) do
        if e.from == id then
          add({
            { text = " → " .. node_label(model, e.to), st = "text" },
            { text = "  " .. (e.label or ""), st = "muted" },
          })
        end
      end
      for _, e in ipairs(model.map.edges) do
        if e.to == id then
          add({
            { text = " ← " .. node_label(model, e.from), st = "text" },
            { text = "  " .. (e.label or ""), st = "muted" },
          })
        end
      end
    end
  end
  local out = { caption(title, w, focused) }
  for r = 1, h - 1 do
    out[#out + 1] = clip(lines[r] or {}, w)
  end
  return out
end

local HINTS = {
  doc = "j/k scroll · ]/[ section · n/N anchor · enter peek · tab map",
  map = "j/k node · ←→ pan · J/K pan down/up · enter peek · tab inspector",
  inspect = "j/k scroll · esc node · tab document",
}

local function status_text(model, st)
  local seq, m = active_message(model, st)
  local flow
  if not seq then
    flow = "no sequence to play"
  elseif st.shown then
    flow = (st.playing and "▶ " or "⏸ ")
      .. st.step
      .. "/"
      .. #seq.messages
      .. " "
      .. node_label(model, m.from)
      .. " → "
      .. node_label(model, m.to)
  else
    flow = "▷ space plays “" .. seq.label .. "”"
  end
  return flow .. " · " .. HINTS[st.focus]
end

--- One frame for a rect of `ctx.width` × `ctx.height` cells.
function M.render(model, st, ctx)
  local w, h = math.max(1, ctx.width or 80), math.max(2, ctx.height or 24)
  st.w, st.h = w, h
  if st.playing then
    advance(model, st, ctx.elapsed or 0)
  end
  local g = geometry(w, h)
  local rows
  if g.wide then
    local doc = render_doc(model, st, g.doc.w, g.doc.h, st.focus == "doc")
    local map = render_map(model, st, g.map.w, g.map.h, st.focus == "map")
    local insp = render_inspect(model, st, g.inspect.w, g.inspect.h, st.focus == "inspect")
    rows = {}
    for r = 1, g.doc.h do
      local line = {}
      for _, s in ipairs(doc[r]) do
        line[#line + 1] = s
      end
      line[#line + 1] = { text = "│", st = "sep" }
      for _, s in ipairs(r <= g.map.h and map[r] or insp[r - g.map.h]) do
        line[#line + 1] = s
      end
      rows[r] = line
    end
  elseif st.focus == "doc" then
    rows = render_doc(model, st, w, g.doc.h, true)
  elseif st.focus == "map" then
    rows = render_map(model, st, w, g.map.h, true)
  else
    rows = render_inspect(model, st, w, g.inspect.h, true)
  end
  local status = status_text(model, st)
  rows[#rows + 1] = clip({ { text = status, st = "status" } }, w)
  return { lines = rows, status = status }
end

return M
