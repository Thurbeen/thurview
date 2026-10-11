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
        out[#out + 1] = { text = cut(s.text, rest), st = s.st, link = s.link, id = s.id }
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

--- The threads by what they are on: a document block, a map part, the review.
local function threads_by_target(st)
  local doc, node, review = {}, {}, {}
  for _, t in ipairs((st and st.threads and st.threads.threads) or {}) do
    if t.target == "document" then
      doc[t.key] = doc[t.key] or {}
      table.insert(doc[t.key], t)
    elseif t.target == "map" then
      node[t.key] = node[t.key] or {}
      table.insert(node[t.key], t)
    elseif t.target == "review" then
      review[#review + 1] = t
    end
  end
  return doc, node, review
end

--- How a thread reads in one word: held for the review, open, or resolved.
local function thread_state(t)
  if not t.submitted then
    return "in your review"
  end
  return t.status
end

local doc_cache = {}

local function build_doc(model, w, st)
  local tv = (st and st.tv) or 0
  if doc_cache.model == model and doc_cache.w == w and doc_cache.tv == tv then
    return doc_cache
  end
  local lines, links, headings, msg_line = {}, {}, {}, {}
  -- Per line: the block it belongs to, or the thread it shows. A click is
  -- resolved through these, and a comment is aimed with them.
  local line_block, line_thread = {}, {}
  local cur_block, cur_thread
  local function add(spans)
    lines[#lines + 1] = spans
    line_block[#lines] = cur_block
    line_thread[#lines] = cur_thread
  end
  local function blank()
    if #lines > 0 and #lines[#lines] > 0 then
      add({})
    end
  end
  local function add_wrapped(runs, first, rest, base_st)
    local before = #links
    -- One column short of the edge, so prose never touches the separator.
    for _, l in ipairs(wrap(runs, math.max(8, w - 1), first, rest, links, #lines, base_st)) do
      add(l)
    end
    for k = before + 1, #links do
      links[k].block = cur_block
    end
  end
  local on_block, _, on_review = threads_by_target(st)
  local last_of = {}
  for bi, b in ipairs(model.blocks) do
    if b.bid then
      last_of[b.bid] = bi
    end
  end
  -- A thread is drawn as a card under the last line of what it is on, the way
  -- the browser pins it under its block.
  local function cards(list)
    for _, t in ipairs(list or {}) do
      cur_thread = t.id
      local label = (t.mode == "ask" and "question" or "comment") .. " · " .. thread_state(t)
      add({
        { text = "  ✎ ", st = "thread" },
        { text = label, st = "thread" },
        { text = "  #" .. t.id, st = "muted" },
      })
      for _, m in ipairs(t.messages) do
        add_wrapped({
          { text = m.role == "agent" and "agent" or "you", strong = true },
          { text = ": " .. m.body },
        }, { text = "  ┃ ", st = "thread" }, { text = "  ┃ ", st = "thread" })
      end
      cur_thread = nil
    end
  end
  local seq_index = 0
  local first_heading = true
  for bi, b in ipairs(model.blocks) do
    local prev = model.blocks[bi - 1]
    cur_block = nil
    if not (prev and prev.t == "item" and b.t == "item") then
      blank()
    end
    cur_block = bi
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
    if b.t == "heading" and first_heading then
      first_heading = false
      cards(on_review)
    end
    if b.bid and last_of[b.bid] == bi then
      cards(on_block[b.bid])
    end
  end
  doc_cache = {
    model = model,
    w = w,
    tv = tv,
    lines = lines,
    links = links,
    headings = headings,
    msg_line = msg_line,
    line_block = line_block,
    line_thread = line_thread,
  }
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
    -- Reviewing: thurview's threads as the bridge last read them (and their
    -- version, which keys the document cache), the selected block and thread,
    -- the composer when one is open, and the writes not yet handed over.
    threads = nil,
    tv = 0,
    block = nil,
    thread = nil,
    compose = nil,
    outbox = {},
    notice = nil,
    -- Why writing is off, when it is: the host sets it.
    readonly = nil,
  }
end

--- Take the bridge's answer: the threads as thurview now has them.
function M.set_threads(st, parsed)
  st.notice = parsed.error and ("thurview: " .. parsed.error) or nil
  -- A refused write answers with the reason alone: what is shown still stands.
  if parsed.status then
    st.threads = parsed
    st.tv = st.tv + 1
  end
end

--- The writes asked for since the last call, each a list of fields:
--- { "create", type, key, mode, body }, { "reply", thread, body },
--- { "status", thread, open|resolved }, { "submit", decision, body }.
function M.take_outbox(st)
  local out = st.outbox
  st.outbox = {}
  return out
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

--- The document as the doc region draws it: a column narrower, for the gutter
--- that marks the selected block.
local function doc_for(model, st)
  return build_doc(model, geometry(st.w, st.h).doc.w - 1, st)
end

local function select_link(model, st, idx)
  local g = geometry(st.w, st.h)
  local doc = doc_for(model, st)
  local link = doc.links[idx]
  if not link then
    return false
  end
  st.link, st.anchor, st.inspect, st.peek = idx, link.anchor, "anchor", 0
  st.block = link.block
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

--- Scroll the document so line `l` is on screen.
local function show_line(st, l, vh)
  if l <= st.scroll or l > st.scroll + vh then
    st.scroll = math.max(0, l - 3)
  end
end

--- What a new comment is on: the selected part in the map, else the selected
--- block, else the first block on screen.
local function comment_target(model, st)
  if st.focus == "map" then
    local L = map_layout(model, st)
    local id = L.order[st.node]
    if id then
      return { type = "map", key = id, label = node_label(model, id) }
    end
  end
  local doc = doc_for(model, st)
  local bi = st.block
  if not bi then
    for l = st.scroll + 1, #doc.lines do
      if doc.line_block[l] then
        bi = doc.line_block[l]
        break
      end
    end
  end
  local b = bi and model.blocks[bi]
  if not (b and b.bid) then
    return { type = "review", key = "", label = "the whole document" }
  end
  st.block = bi
  local words = b.text
  if not words and b.runs then
    local parts = {}
    for _, r in ipairs(b.runs) do
      parts[#parts + 1] = r.text
    end
    words = table.concat(parts)
  end
  return { type = "document", key = b.bid, label = cut(words or b.label or b.t, 40) }
end

local function open_composer(st, compose)
  if st.readonly then
    st.notice = st.readonly
    return
  end
  compose.text = ""
  st.compose = compose
end

--- Every thread, in the order the bridge listed them.
local function thread_list(st)
  return (st.threads and st.threads.threads) or {}
end

local function find_thread(st, id)
  for i, t in ipairs(thread_list(st)) do
    if t.id == id then
      return t, i
    end
  end
end

local function select_thread(model, st, id)
  local t = find_thread(st, id)
  if not t then
    return false
  end
  st.thread, st.inspect = id, "thread"
  local doc = doc_for(model, st)
  for l, tid in pairs(doc.line_thread) do
    if tid == id then
      show_line(st, l, geometry(st.w, st.h).doc.h - 1)
      break
    end
  end
  return true
end

--- Keys shared by every region: commenting, replying, resolving, submitting.
local function review_key(model, st, key)
  if key == "c" or key == "C" then
    local target = key == "C" and { type = "review", key = "", label = "the whole document" }
      or comment_target(model, st)
    open_composer(st, { kind = "comment", target = target, mode = "review" })
  elseif key == "R" then
    open_composer(st, { kind = "submit", decision = "approve" })
  elseif key == "t" or key == "T" then
    local list = thread_list(st)
    if #list == 0 then
      return false
    end
    local _, i = find_thread(st, st.thread)
    i = i or (key == "t" and 0 or 1)
    i = (i + (key == "t" and 1 or -1) - 1) % #list + 1
    select_thread(model, st, list[i].id)
  elseif key == "r" and st.thread then
    open_composer(st, { kind = "reply", thread = st.thread })
  elseif key == "x" and st.thread then
    local t = find_thread(st, st.thread)
    if t and not st.readonly then
      st.outbox[#st.outbox + 1] =
        { "status", t.id, t.status == "resolved" and "open" or "resolved" }
    elseif st.readonly then
      st.notice = st.readonly
    end
  else
    return false
  end
  return true
end

local DECISIONS = { "approve", "request-changes", "close" }
local DECISION_LABEL =
  { approve = "Approve", ["request-changes"] = "Request changes", close = "Close" }

--- Hand the composer's text over as a write, and close it.
local function send(st, mode, decision)
  local c = st.compose
  if not c then
    return
  end
  if c.kind == "submit" then
    st.outbox[#st.outbox + 1] = { "submit", decision or c.decision, c.text }
  elseif c.text:match("^%s*$") then
    st.notice = "nothing to send: type the comment first"
    return
  elseif c.kind == "reply" then
    st.outbox[#st.outbox + 1] = { "reply", c.thread, c.text }
  else
    st.outbox[#st.outbox + 1] = { "create", c.target.type, c.target.key, mode or c.mode, c.text }
  end
  st.compose = nil
  st.notice = "saving to thurview…"
end

--- The composer takes every key while it is open: a letter is a letter, not a command.
local function compose_key(st, key, char)
  local c = st.compose
  if key == "esc" then
    st.compose = nil
  elseif key == "enter" then
    send(st)
  elseif key == "tab" or key == "backtab" then
    if c.kind == "submit" then
      local i = 1
      for k, d in ipairs(DECISIONS) do
        if d == c.decision then
          i = k
        end
      end
      c.decision = DECISIONS[(i + (key == "tab" and 0 or -2)) % #DECISIONS + 1]
    elseif c.kind == "comment" then
      c.mode = c.mode == "review" and "ask" or "review"
    end
  elseif key == "backspace" then
    local last = utf8.offset(c.text, -1)
    if last then
      c.text = c.text:sub(1, last - 1)
    end
  elseif key == "space" then
    c.text = c.text .. " "
  elseif char and char ~= "" and not char:match("%c") then
    c.text = c.text .. char
  elseif utf8.len(key) == 1 then
    c.text = c.text .. key
  end
  return true
end

local function doc_key(model, st, key)
  local g = geometry(st.w, st.h)
  local doc = doc_for(model, st)
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
  elseif key == "J" or key == "K" then
    -- The block cursor: what a comment is aimed at.
    local cur = st.block or 0
    local step = key == "J" and 1 or -1
    local bi = cur + step
    while model.blocks[bi] and model.blocks[bi].bid == (model.blocks[cur] or {}).bid do
      bi = bi + step
    end
    if model.blocks[bi] then
      st.block = bi
      for l, b in pairs(doc.line_block) do
        if b == bi then
          show_line(st, l, vh)
          break
        end
      end
    end
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
  if (key == "esc" or key == "backspace") and st.inspect == "thread" then
    st.inspect, st.thread = "node", nil
  elseif key == "j" or key == "down" then
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
function M.key(model, st, key, ctx, char)
  if ctx and ctx.width then
    st.w, st.h = ctx.width, ctx.height
  end
  if st.compose then
    return compose_key(st, key, char)
  end
  st.notice = nil
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
  if review_key(model, st, key) then
    return true
  end
  if st.focus == "doc" then
    return doc_key(model, st, key)
  elseif st.focus == "map" then
    return map_key(model, st, key)
  end
  return inspect_key(st, key)
end

--- A click on something the view drew, by the id it gave the span.
function M.click(model, st, id, clicks)
  if not id then
    return false
  end
  local kind, rest = id:match("^(%a+):(.*)$")
  if st.compose then
    if id == "btn:cancel" then
      st.compose = nil
    elseif kind == "send" then
      send(st, rest)
    elseif kind == "decide" then
      send(st, nil, rest)
    end
    return true
  end
  st.notice = nil
  if kind == "link" then
    st.focus = "doc"
    return select_link(model, st, tonumber(rest))
  elseif kind == "block" then
    st.focus, st.block = "doc", tonumber(rest)
    if clicks == 2 then
      open_composer(st, { kind = "comment", target = comment_target(model, st), mode = "review" })
    end
  elseif kind == "thread" then
    select_thread(model, st, rest)
  elseif kind == "node" then
    local L = map_layout(model, st)
    for i, nid in ipairs(L.order) do
      if nid == rest then
        st.node, st.inspect, st.focus = i, "node", "map"
      end
    end
    if clicks == 2 then
      open_composer(st, { kind = "comment", target = comment_target(model, st), mode = "review" })
    end
  elseif kind == "focus" then
    st.focus = rest
  elseif id == "btn:play" then
    return M.key(model, st, "space")
  elseif id == "btn:review" then
    return M.key(model, st, "R")
  else
    return false
  end
  return true
end

--- The block a target names: `block:<compiled block id>`.
local function block_of(model, bid)
  for i, b in ipairs(model.blocks) do
    if b.bid == bid then
      return i
    end
  end
end

--- Resolve `block:<id>`, `node:<id>` or `review` to a comment target, or the
--- current selection when there is none.
local function target_of(model, st, spec)
  if not spec or spec == "" then
    return comment_target(model, st)
  end
  local kind, key = spec:match("^(%a+):(.+)$")
  if spec == "review" then
    return { type = "review", key = "", label = "the whole document" }
  elseif kind == "block" and block_of(model, key) then
    st.block = block_of(model, key)
    st.focus = "doc"
    return comment_target(model, st)
  elseif kind == "node" then
    return { type = "map", key = key, label = node_label(model, key) }
  end
end

--- The same operations as the keys and the mouse, by name and typed
--- arguments, for whoever drives the pane without either: `thurbox-cli ui
--- action thurview.<name> --arg k=v`. Every one of them is something a click
--- or a key also does, so nothing here is reachable only by an agent.
---
---   select  target=block:<id>|node:<id>|anchor:<id>|thread:<id>
---   comment target=block:<id>|node:<id>|review  body=<text>  [mode=review|ask]
---   reply   thread=<id> body=<text>
---   resolve thread=<id> [status=resolved|open]
---   submit  decision=approve|request-changes|close  [body=<text>]
function M.act(model, st, name, args)
  args = args or {}
  st.notice = nil
  local function refuse(why)
    st.notice = why
    return false
  end
  if name == "select" then
    local kind, key = (args.target or ""):match("^(%a+):(.+)$")
    if kind == "block" and block_of(model, key) then
      return M.click(model, st, "block:" .. block_of(model, key), 1)
    elseif kind == "node" then
      return M.click(model, st, "node:" .. key, 1)
    elseif kind == "thread" then
      return select_thread(model, st, key)
    elseif kind == "anchor" then
      for i, l in ipairs(doc_for(model, st).links) do
        if l.anchor == key then
          st.focus = "doc"
          return select_link(model, st, i)
        end
      end
    end
    return refuse("nothing to select at " .. tostring(args.target))
  end
  if st.readonly then
    return refuse(st.readonly)
  end
  local body = args.body or ""
  if name == "comment" then
    local target = target_of(model, st, args.target)
    if not target then
      return refuse("no block or part " .. tostring(args.target))
    end
    if body:match("^%s*$") then
      return refuse("a comment needs a body")
    end
    local mode = args.mode == "ask" and "ask" or "review"
    st.outbox[#st.outbox + 1] = { "create", target.type, target.key, mode, body }
  elseif name == "reply" then
    if not (args.thread and find_thread(st, args.thread)) or body:match("^%s*$") then
      return refuse("a reply needs a known thread and a body")
    end
    st.outbox[#st.outbox + 1] = { "reply", args.thread, body }
  elseif name == "resolve" then
    local t = args.thread and find_thread(st, args.thread)
    if not t then
      return refuse("no thread " .. tostring(args.thread))
    end
    local status = args.status or (t.status == "resolved" and "open" or "resolved")
    st.outbox[#st.outbox + 1] = { "status", t.id, status }
  elseif name == "submit" then
    local ok = false
    for _, d in ipairs(DECISIONS) do
      ok = ok or d == args.decision
    end
    if not ok then
      return refuse("decision is approve, request-changes or close")
    end
    st.outbox[#st.outbox + 1] = { "submit", args.decision, body }
  else
    return false
  end
  st.compose = nil
  st.notice = "saving to thurview…"
  return true
end

--- What `thurbox-cli ui state` shows of the pane: enough to know what it is on
--- and whether a write landed, without reading the screen.
function M.public_state(model, st)
  local pending, open = 0, 0
  for _, t in ipairs(thread_list(st)) do
    if not t.submitted then
      pending = pending + 1
    elseif t.status == "open" then
      open = open + 1
    end
  end
  local L = map_layout(model, st)
  local b = st.block and model.blocks[st.block]
  return {
    review = model.review or "",
    revision = model.revision,
    focus = st.focus,
    block = b and b.bid or "",
    node = L.order[st.node] or "",
    thread = st.thread or "",
    anchor = st.anchor or "",
    composing = st.compose and st.compose.kind or "",
    flow_step = st.step,
    flow_playing = st.playing,
    threads = #thread_list(st),
    threads_open = open,
    threads_in_review = pending,
    review_status = (st.threads and st.threads.status) or "",
    writable = st.readonly == nil,
    notice = st.notice or "",
  }
end

--- A wheel tick at (x, y) inside the pane: it scrolls whatever is under it.
function M.scroll(model, st, up, x, y)
  local g = geometry(st.w, st.h)
  local region = st.focus
  if g.wide then
    region = x < g.doc.w and "doc" or (y < g.map.h and "map" or "inspect")
  end
  local d = up and -3 or 3
  if region == "doc" then
    local doc = doc_for(model, st)
    st.scroll = clamp(st.scroll + d, 0, math.max(0, #doc.lines - (g.doc.h - 1)))
  elseif region == "map" then
    local L, _, vh = map_layout(model, st)
    st.pan_y = clamp(st.pan_y + d, 0, math.max(0, L.h - vh))
  else
    st.peek = math.max(0, st.peek + d)
  end
  return true
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
  local doc = build_doc(model, w - 1, st)
  local max = math.max(0, #doc.lines - (h - 1))
  st.scroll = clamp(st.scroll, 0, max)
  local pct = max == 0 and 100 or math.floor(st.scroll * 100 / max)
  local out = { caption("document · " .. pct .. "%", w, focused) }
  out[1][1].id = "focus:doc"
  local msgs = doc.msg_line[st.seq]
  local lit = {}
  if st.shown and msgs and msgs[st.step] then
    for l = msgs[st.step].first, msgs[st.step].last do
      lit[l] = true
    end
  end
  for r = 1, h - 1 do
    local i = st.scroll + r
    local bi, tid = doc.line_block[i], doc.line_thread[i]
    local base = tid and ("thread:" .. tid) or (bi and ("block:" .. bi)) or nil
    local marked = (tid and tid == st.thread) or (not tid and bi and bi == st.block)
    local spans = { { text = marked and "▌" or " ", st = "sel_block", id = base } }
    for _, s in ipairs(doc.lines[i] or {}) do
      local style = s.st
      if s.link and s.link == st.link then
        style = "link_sel"
      elseif tid and tid == st.thread then
        style = "thread_sel"
      elseif lit[i] and style ~= "muted" then
        style = "flow"
      end
      spans[#spans + 1] = { text = s.text, st = style, id = s.link and ("link:" .. s.link) or base }
    end
    local row = clip(spans, w)
    row[#row].id = row[#row].id or base
    out[#out + 1] = row
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
  out[1][1].id = (st.shown and m) and "btn:play" or "focus:map"
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
      local id = cell and cell.node and ("node:" .. cell.node) or nil
      if cur and cur.st == style and cur.id == id then
        cur.text = cur.text .. ch
      else
        cur = { text = ch, st = style, id = id }
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
  local th = st.inspect == "thread" and find_thread(st, st.thread)
  if th then
    title = "thread · #" .. th.id
    local on = th.target == "map" and node_label(model, th.key)
      or th.target == "review" and "the whole document"
      or "a block of the document"
    add({
      {
        text = " ✎ " .. (th.mode == "ask" and "question" or "comment") .. " on " .. on,
        st = "strong",
      },
    })
    add({
      { text = "   " .. thread_state(th) .. " · revision " .. (th.revision or "?"), st = "muted" },
    })
    add({})
    for _, msg in ipairs(th.messages) do
      para(
        (msg.role == "agent" and "agent: " or "you: ") .. msg.body,
        msg.role == "agent" and "text" or "strong",
        " ┃ "
      )
    end
    add({})
    add({
      {
        text = " r reply · x "
          .. (th.status == "resolved" and "reopen" or "resolve")
          .. " · esc back",
        st = "muted",
      },
    })
  elseif a then
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
      local _, on_node = threads_by_target(st)
      for _, t in ipairs(on_node[id] or {}) do
        local last = t.messages[#t.messages]
        local line =
          { { text = " ✎ " .. thread_state(t) .. "  ", st = "thread", id = "thread:" .. t.id } }
        line[2] = {
          text = last and ((last.role == "agent" and "agent: " or "you: ") .. last.body) or "",
          st = "text",
          id = "thread:" .. t.id,
        }
        add(line)
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
  out[1][1].id = "focus:inspect"
  for r = 1, h - 1 do
    out[#out + 1] = clip(lines[r] or {}, w)
  end
  return out
end

--- The composer, three rows across the bottom of the pane, every button a click target.
local function render_composer(model, st, w)
  local c = st.compose
  local title, buttons
  if c.kind == "submit" then
    title = " submit your review "
    buttons = {}
    for _, d in ipairs(DECISIONS) do
      buttons[#buttons + 1] = {
        text = " " .. DECISION_LABEL[d] .. " ",
        st = d == c.decision and "button_on" or "button",
        id = "decide:" .. d,
      }
      buttons[#buttons + 1] = { text = " ", st = "text" }
    end
    buttons[#buttons + 1] = { text = " ⇥ choose · ⏎ submit · ", st = "muted" }
  elseif c.kind == "reply" then
    title = " reply to #" .. c.thread .. " "
    buttons = {
      { text = " ⏎ Send reply ", st = "button_on", id = "send:reply" },
      { text = " ", st = "text" },
    }
  else
    title = " comment on " .. c.target.label .. " "
    buttons = {
      {
        text = " Add to review ",
        st = c.mode == "review" and "button_on" or "button",
        id = "send:review",
      },
      { text = " ", st = "text" },
      { text = " Ask now ", st = c.mode == "ask" and "button_on" or "button", id = "send:ask" },
      { text = "  ⇥ switch · ⏎ send · ", st = "muted" },
    }
  end
  buttons[#buttons + 1] = { text = " Cancel ", st = "button", id = "btn:cancel" }
  local typed = c.text
  local room = w - 4
  if D.width(typed) > room then
    typed = "…" .. typed:sub(utf8.offset(typed, -(room - 1)) or 1)
  end
  local _ = model
  return {
    clip(
      { { text = "✎" .. title, st = "focus" }, { text = string.rep("─", w), st = "rule" } },
      w
    ),
    clip({
      { text = " > ", st = "muted" },
      { text = typed, st = "text" },
      { text = "▏", st = "focus" },
    }, w),
    clip(buttons, w),
  }
end

local HINTS = {
  doc = "j/k scroll · ]/[ section · n/N anchor · J/K block · c comment · t thread · R review · tab map",
  map = "j/k node · ←→ pan · J/K pan · c comment · t thread · R review · tab inspector",
  inspect = "j/k scroll · r reply · x resolve · esc back · tab document",
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
  local review = ""
  local pending = 0
  for _, t in ipairs(thread_list(st)) do
    if not t.submitted then
      pending = pending + 1
    end
  end
  if pending > 0 then
    review = " · ✎ " .. pending .. " in your review, R submits"
  elseif st.threads and st.threads.status then
    review = " · review " .. st.threads.status
  end
  if st.compose then
    return flow .. " · composing: esc cancels" .. review
  end
  if st.notice then
    return flow .. " · " .. st.notice .. review
  end
  return flow .. review .. " · " .. HINTS[st.focus]
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
  if st.compose and #rows >= 3 then
    local box = render_composer(model, st, w)
    for i = 1, 3 do
      rows[#rows - 3 + i] = box[i]
    end
  end
  local status = status_text(model, st)
  rows[#rows + 1] = clip({ { text = status, st = "status" } }, w)
  return { lines = rows, status = status }
end

return M
