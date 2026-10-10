-- The architecture map as a grid of terminal cells.
--
-- A layered drawing, the way a dot graph is: break cycles, put each node on the
-- layer after its deepest predecessor, thread a long edge through placeholder
-- cells on the layers it skips, order each layer by the barycentre of its
-- neighbours, then route every edge down through the channel between two
-- layers. Each channel has a row per horizontal run, so two runs never share a
-- cell lengthwise, a row for labels and a row for arrowheads.
--
-- Pure data in, pure data out: no thurbox global is read, so the same file runs
-- in the pane and in the test driver. The view crops this grid to the pane and
-- paints the selection and the flow highlight over it.
local M = {}

-- A line cell's glyph, by the sides it connects: north, east, south, west.
local LINE = {
  n = "│",
  s = "│",
  ns = "│",
  e = "─",
  w = "─",
  ew = "─",
  es = "┌",
  sw = "┐",
  ne = "└",
  nw = "┘",
  nes = "├",
  nsw = "┤",
  esw = "┬",
  new = "┴",
  nesw = "┼",
}
local GAP = 3 -- columns between two boxes on one layer
local LABEL_MAX = 22 -- columns an edge label may take before it is cut

local function width(s)
  return utf8.len(s) or #s
end

--- `s` cut to `n` columns, with an ellipsis when anything was cut.
local function cut(s, n)
  if n <= 0 then
    return ""
  end
  if width(s) <= n then
    return s
  end
  if n == 1 then
    return "…"
  end
  return s:sub(1, (utf8.offset(s, n) or (#s + 1)) - 1) .. "…"
end
M.cut = cut
M.width = width

--- Only leaves are drawn: a node with children is a boundary, and the inspector
--- names it as the parent of what is inside it.
local function leaves(map)
  local parent_of, has_child, by_id = {}, {}, {}
  for _, n in ipairs(map.nodes) do
    by_id[n.id] = n
  end
  for _, n in ipairs(map.nodes) do
    local p = n.id:match("^(.*)%.[^.]+$")
    if p and by_id[p] then
      has_child[p] = true
      parent_of[n.id] = p
    end
  end
  local out = {}
  for _, n in ipairs(map.nodes) do
    if not has_child[n.id] then
      out[#out + 1] = n
    end
  end
  return out, parent_of, by_id
end

--- Longest-path layers over the graph with its back edges turned around.
local function layer(ids, edges)
  local out = {}
  for _, id in ipairs(ids) do
    out[id] = {}
  end
  for k, e in ipairs(edges) do
    out[e.from][#out[e.from] + 1] = k
  end
  -- Depth-first in declaration order: an edge into a node still on the stack
  -- closes a cycle, and is drawn reversed so the layers stay acyclic.
  local mark = {}
  local function visit(id)
    mark[id] = "open"
    for _, k in ipairs(out[id]) do
      local to = edges[k].to
      if mark[to] == "open" then
        edges[k].rev = true
      elseif not mark[to] then
        visit(to)
      end
    end
    mark[id] = "done"
  end
  for _, id in ipairs(ids) do
    if not mark[id] then
      visit(id)
    end
  end
  local level = {}
  for _, id in ipairs(ids) do
    level[id] = 0
  end
  -- Relax until nothing moves: at most one pass per node on an acyclic graph.
  for _ = 1, #ids do
    local moved = false
    for _, e in ipairs(edges) do
      local a, b = e.from, e.to
      if e.rev then
        a, b = b, a
      end
      if level[b] < level[a] + 1 then
        level[b] = level[a] + 1
        moved = true
      end
    end
    if not moved then
      break
    end
  end
  return level
end

function M.layout(map, opts)
  opts = opts or {}
  local box_max = opts.box_max or 24
  local nodes, parent_of, by_id = leaves(map)
  local drawn, ids = {}, {}
  for _, n in ipairs(nodes) do
    drawn[n.id] = true
    ids[#ids + 1] = n.id
  end
  local edges, hidden = {}, 0
  for _, e in ipairs(map.edges) do
    if drawn[e.from] and drawn[e.to] and e.from ~= e.to then
      edges[#edges + 1] = { from = e.from, to = e.to, label = e.label }
    else
      hidden = hidden + 1
    end
  end
  local level = layer(ids, edges)

  -- Vertices: the real nodes, then one placeholder per layer a long edge skips.
  local V = {}
  local layers = {}
  local function add_vertex(v)
    V[v.id] = v
    layers[v.layer + 1] = layers[v.layer + 1] or {}
    local l = layers[v.layer + 1]
    l[#l + 1] = v.id
  end
  for _, n in ipairs(nodes) do
    local label = n.label
    local tag = n.status == "added" and " new " or n.status == "changed" and " changes " or ""
    local inner = math.max(width(label), width(n.kind) + width(tag) + 4)
    local w = math.min(inner, box_max - 4) + 4
    add_vertex({ id = n.id, layer = level[n.id], w = w, node = n, tag = tag })
  end
  local segments = {}
  for k, e in ipairs(edges) do
    local a, b = e.from, e.to
    if e.rev then
      a, b = b, a
    end
    local prev = a
    for l = level[a] + 1, level[b] - 1 do
      local id = "\0" .. k .. ":" .. l
      add_vertex({ id = id, layer = l, w = 1, dummy = k })
      segments[#segments + 1] = { edge = k, from = prev, to = id, first = prev == a, last = false }
      prev = id
    end
    segments[#segments + 1] = { edge = k, from = prev, to = b, first = prev == a, last = true }
  end
  for l = 1, #layers do
    layers[l] = layers[l] or {}
  end

  -- Order: a few barycentre sweeps, down then up.
  local ups, downs = {}, {}
  for _, s in ipairs(segments) do
    downs[s.from] = downs[s.from] or {}
    table.insert(downs[s.from], s.to)
    ups[s.to] = ups[s.to] or {}
    table.insert(ups[s.to], s.from)
  end
  local pos = {}
  local function index()
    for _, l in ipairs(layers) do
      for i, id in ipairs(l) do
        pos[id] = i
      end
    end
  end
  index()
  local function sweep(l, nbrs)
    local bary = {}
    for i, id in ipairs(l) do
      local list, sum = nbrs[id], 0
      if list and #list > 0 then
        for _, o in ipairs(list) do
          sum = sum + pos[o]
        end
        bary[id] = sum / #list
      else
        bary[id] = i
      end
    end
    table.sort(l, function(a, b)
      if bary[a] ~= bary[b] then
        return bary[a] < bary[b]
      end
      return pos[a] < pos[b]
    end)
    for i, id in ipairs(l) do
      pos[id] = i
    end
  end
  for _ = 1, 4 do
    for l = 2, #layers do
      sweep(layers[l], ups)
    end
    for l = #layers - 1, 1, -1 do
      sweep(layers[l], downs)
    end
  end

  -- Columns: each vertex as near the centre of its upper neighbours as the
  -- order and the gap allow; the first layer is packed.
  local x = {}
  for li, l in ipairs(layers) do
    local right = 0
    for _, id in ipairs(l) do
      local v = V[id]
      local want = right
      local list = ups[id]
      if li > 1 and list and #list > 0 then
        local sum = 0
        for _, o in ipairs(list) do
          sum = sum + x[o] + V[o].w / 2
        end
        want = math.floor(sum / #list - v.w / 2 + 0.5)
      end
      x[id] = math.max(want, right)
      right = x[id] + v.w + GAP
    end
  end
  local min_x = math.huge
  for id in pairs(V) do
    min_x = math.min(min_x, x[id])
  end
  for id in pairs(V) do
    x[id] = x[id] - min_x + 1
  end

  -- Ports along the bottom and top of each box, ordered by where the other end is.
  local bottom, top = {}, {}
  for k, s in ipairs(segments) do
    bottom[s.from] = bottom[s.from] or {}
    table.insert(bottom[s.from], k)
    top[s.to] = top[s.to] or {}
    table.insert(top[s.to], k)
  end
  local function centre(id)
    return x[id] + V[id].w / 2
  end
  local function ports(id, list, other)
    if not list then
      return
    end
    table.sort(list, function(a, b)
      return centre(segments[a][other]) < centre(segments[b][other])
    end)
    local v = V[id]
    for i, k in ipairs(list) do
      local px
      if v.dummy then
        px = x[id]
      else
        local span = math.max(1, v.w - 4)
        px = x[id] + 2 + math.floor((i - 0.5) * span / #list)
      end
      segments[k][other == "to" and "x1" or "x2"] = px
    end
  end
  for id in pairs(V) do
    ports(id, bottom[id], "to")
    ports(id, top[id], "from")
  end

  -- Lanes per channel: one row per horizontal run that would overlap another.
  local by_channel = {}
  for _, s in ipairs(segments) do
    local c = V[s.from].layer + 1
    by_channel[c] = by_channel[c] or {}
    table.insert(by_channel[c], s)
  end
  local lanes = {}
  for c = 1, #layers do
    local list = by_channel[c] or {}
    local runs = {}
    for _, s in ipairs(list) do
      if s.x1 ~= s.x2 then
        runs[#runs + 1] = s
      end
    end
    table.sort(runs, function(a, b)
      return math.min(a.x1, a.x2) < math.min(b.x1, b.x2)
    end)
    local ends = {}
    for _, s in ipairs(runs) do
      local lo, hi = math.min(s.x1, s.x2), math.max(s.x1, s.x2)
      local lane
      for i, e in ipairs(ends) do
        if e < lo - 1 then
          lane = i
          break
        end
      end
      lane = lane or #ends + 1
      ends[lane] = hi
      s.lane = lane
    end
    lanes[c] = #ends
  end

  -- Rows: a layer is three rows of boxes, then its channel: a stub row, the
  -- lanes, a label row and an arrow row.
  local y, row = {}, 1
  local channel = {}
  for li = 1, #layers do
    y[li] = row
    row = row + 3
    if li < #layers then
      channel[li] =
        { stub = row, lane0 = row, label = row + 1 + lanes[li], arrow = row + 2 + lanes[li] }
      row = row + 3 + lanes[li]
    end
  end
  local height = row - 1

  -- The grid.
  local cells = {}
  local maxw = 0
  local function cell(cx, cy)
    local r = cells[cy]
    if not r then
      r = {}
      cells[cy] = r
    end
    local c = r[cx]
    if not c then
      c = {}
      r[cx] = c
    end
    if cx > maxw then
      maxw = cx
    end
    return c
  end
  local function put(cx, cy, ch, cls, owner)
    local c = cell(cx, cy)
    c.ch, c.cls = ch, cls
    if owner then
      c.node = owner
    end
  end
  local function link(cx, cy, side, k)
    local c = cell(cx, cy)
    c[side] = true
    c.line = true
    c.edges = c.edges or {}
    c.edges[k] = true
  end
  local function walk(points, k)
    for i = 1, #points - 1 do
      local ax, ay, bx, by = points[i][1], points[i][2], points[i + 1][1], points[i + 1][2]
      while ax ~= bx or ay ~= by do
        local nx, ny, side, back = ax, ay, nil, nil
        if ax < bx then
          nx, side, back = ax + 1, "e", "w"
        elseif ax > bx then
          nx, side, back = ax - 1, "w", "e"
        elseif ay < by then
          ny, side, back = ay + 1, "s", "n"
        else
          ny, side, back = ay - 1, "n", "s"
        end
        link(ax, ay, side, k)
        link(nx, ny, back, k)
        ax, ay = nx, ny
      end
    end
  end

  local out_edges = {}
  for k, e in ipairs(edges) do
    out_edges[k] = {
      from = e.from,
      to = e.to,
      label = e.label,
      rev = e.rev,
      x1 = math.huge,
      y1 = math.huge,
      x2 = 0,
      y2 = 0,
    }
  end
  for _, s in ipairs(segments) do
    local li = V[s.from].layer + 1
    local ch = channel[li]
    local y_from = y[li] + 2 -- the source's bottom border
    local y_to = y[li + 1] -- the target's top border
    local pts
    if V[s.from].dummy then
      walk({ { s.x1, y[li] }, { s.x1, y[li] + 2 } }, s.edge)
    end
    if s.x1 == s.x2 then
      pts = { { s.x1, y_from }, { s.x2, y_to - 1 } }
    else
      local ly = ch.lane0 + s.lane
      pts = { { s.x1, y_from }, { s.x1, ly }, { s.x2, ly }, { s.x2, y_to - 1 } }
    end
    if V[s.to].dummy then
      pts[#pts + 1] = { s.x2, y_to }
    end
    walk(pts, s.edge)
    local b = out_edges[s.edge]
    for _, p in ipairs(pts) do
      b.x1, b.y1 = math.min(b.x1, p[1]), math.min(b.y1, p[2])
      b.x2, b.y2 = math.max(b.x2, p[1]), math.max(b.y2, p[2])
    end
    s.y_from, s.y_to, s.channel = y_from, y_to, ch
  end
  for _, r in pairs(cells) do
    for _, c in pairs(r) do
      if c.line then
        local key = (c.n and "n" or "")
          .. (c.e and "e" or "")
          .. (c.s and "s" or "")
          .. (c.w and "w" or "")
        c.ch, c.cls = LINE[key] or "┼", "line"
      end
    end
  end

  -- Boxes over the lines.
  local placed = {}
  for id, v in pairs(V) do
    if not v.dummy then
      local n = v.node
      local bx, by, w = x[id], y[v.layer + 1], v.w
      local added = n.status == "added"
      local cls = added and "box_added" or n.status == "changed" and "box_changed" or "box"
      local h, vv = added and "╌" or "─", added and "┊" or "│"
      local tl, tr, bl, br = "╭", "╮", "╰", "╯"
      if added then
        tl, tr, bl, br = "┌", "┐", "└", "┘"
      end
      put(bx, by, tl, cls, id)
      put(bx + w - 1, by, tr, cls, id)
      put(bx, by + 2, bl, cls, id)
      put(bx + w - 1, by + 2, br, cls, id)
      for i = 1, w - 2 do
        put(bx + i, by, h, cls, id)
        put(bx + i, by + 2, h, cls, id)
      end
      put(bx, by + 1, vv, cls, id)
      put(bx + w - 1, by + 1, vv, cls, id)
      local kind = " " .. cut(n.kind, w - 6) .. " "
      local i = 0
      for _, c in utf8.codes(kind) do
        put(bx + 2 + i, by, utf8.char(c), "kind", id)
        i = i + 1
      end
      local label = cut(n.label, w - 4)
      local pad = label .. string.rep(" ", w - 4 - width(label))
      put(bx + 1, by + 1, " ", "label", id)
      i = 0
      for _, c in utf8.codes(pad) do
        put(bx + 2 + i, by + 1, utf8.char(c), "label", id)
        i = i + 1
      end
      put(bx + w - 2, by + 1, " ", "label", id)
      -- The proposal's mark sits top right: the bottom border is where ports go.
      if v.tag ~= "" and width(kind) + width(v.tag) + 4 <= w then
        i = 0
        for _, c in utf8.codes(v.tag) do
          put(
            bx + w - 2 - width(v.tag) + i,
            by,
            utf8.char(c),
            cls == "box" and "kind" or cls .. "_tag",
            id
          )
          i = i + 1
        end
      end
      placed[id] =
        { x = bx, y = by, w = w, h = 3, label = n.label, kind = n.kind, status = n.status }
    end
  end

  -- Ports, arrowheads and the bends through placeholder rows.
  for _, s in ipairs(segments) do
    local e = out_edges[s.edge]
    if not V[s.from].dummy then
      local c = cell(s.x1, s.y_from)
      c.ch, c.cls = "┬", c.cls
      c.edges = c.edges or {}
      c.edges[s.edge] = true
    end
    if s.last and not e.rev then
      local c = cell(s.x2, s.y_to - 1)
      c.ch, c.cls = "▼", "arrow"
    end
    if s.first and e.rev then
      local c = cell(s.x1, s.y_from + 1)
      c.ch, c.cls = "▲", "arrow"
    end
  end

  -- Labels, each in its channel's label row beside the run that carries it,
  -- cut to the free cells there and left off when fewer than six are free.
  local unlabelled = 0
  local function free(cx, cy)
    local r = cells[cy]
    return not (r and r[cx] and r[cx].ch)
  end
  for _, s in ipairs(segments) do
    local e = out_edges[s.edge]
    local wants = e.label and ((s.last and not e.rev) or (s.first and e.rev))
    if wants then
      -- Beside its arrowhead: the label row above a downward arrow, the stub
      -- row under the box for an upward one.
      local down = s.last and not e.rev
      local ly = down and s.channel.label or s.channel.stub
      local ax = down and s.x2 or s.x1
      local text = cut(e.label, LABEL_MAX)
      local function run_right()
        local n = 0
        while n < width(text) + 1 and free(ax + 2 + n, ly) do
          n = n + 1
        end
        return n
      end
      local function run_left()
        local n = 0
        while n < width(text) + 1 and ax - 2 - n >= 1 and free(ax - 2 - n, ly) do
          n = n + 1
        end
        return n
      end
      local right, left =
        free(ax + 1, ly) and run_right() or 0, free(ax - 1, ly) and run_left() or 0
      local room, start
      if right >= width(text) + 1 or right >= left then
        room = right - 1
        start = ax + 2
      else
        room = left - 1
        start = nil
      end
      if room >= math.min(width(text), 6) then
        local shown = cut(text, room)
        start = start or (ax - 1 - width(shown))
        local i = 0
        for _, c in utf8.codes(shown) do
          local lc = cell(start + i, ly)
          lc.ch, lc.cls, lc.label = utf8.char(c), "edge_label", s.edge
          lc.edges = { [s.edge] = true }
          i = i + 1
        end
        e.labelled = true
      else
        unlabelled = unlabelled + 1
      end
    end
  end

  local order = {}
  for _, n in ipairs(nodes) do
    order[#order + 1] = n.id
  end
  local index_of = {}
  for k, e in ipairs(out_edges) do
    index_of[e.from .. ">" .. e.to] = k
  end
  return {
    w = maxw + 1,
    h = height,
    cells = cells,
    nodes = placed,
    order = order,
    edges = out_edges,
    edge_index = index_of,
    parent_of = parent_of,
    by_id = by_id,
    hidden = hidden,
    unlabelled = unlabelled,
  }
end

return M
