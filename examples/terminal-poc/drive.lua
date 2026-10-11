-- Drive the pane's view without thurbox, in the Lua 5.4 thurbox embeds: what
-- the tests run, and the cheapest way for an agent to see and use the pane.
--
--   lua5.4 drive.lua <interface dir> [model.lua] < script
--
-- One command per line on stdin:
--
--   size <cols> <rows>     the rect the pane is handed
--   key <name>             a key as thurbox names it: j, tab, right, space, ], R
--   type <text>            the rest of the line, one key per character
--   click <row> <col>      a press on that cell (1-based), as the host reports it
--   clicktext <text>       a press on the first cell showing <text> in the last frame
--   wheel <up|down> <row> <col>
--   act <name> k=v|k=v     a named operation, as `thurbox-cli ui action thurview.<name>` sends it
--   threads <file>         take a bridge.mjs answer as thurview's threads
--   render <elapsed>       draw a frame at that animation clock, in seconds: one JSON
--                          object (rows, flow cells, status, writes asked for) and a form feed
--   print <elapsed>        draw a frame as plain text, the status line last
local ui = assert(arg[1], "usage: lua5.4 drive.lua <interface dir> [model.lua] < script")
package.path = ui .. "/?.lua;" .. package.path

local view = require("thurview_poc.view")
local threads = require("thurview_poc.threads")
-- A second argument names a model file to draw instead of the installed one.
local model = arg[2] and dofile(arg[2]) or require("thurview_poc.model")

local function json_string(s)
  return '"'
    .. s:gsub('[%c"\\]', function(c)
      if c == '"' then
        return '\\"'
      elseif c == "\\" then
        return "\\\\"
      end
      return string.format("\\u%04x", c:byte())
    end)
    .. '"'
end

local function json_list(items)
  local out = {}
  for i, s in ipairs(items) do
    out[i] = json_string(s)
  end
  return "[" .. table.concat(out, ",") .. "]"
end

local st = view.new(model)
local cols, rows = 80, 24
local last -- the last frame drawn, for clicks

local function draw(elapsed)
  last = view.render(model, st, { width = cols, height = rows, elapsed = elapsed })
  return last
end

--- The id of the span under a cell.
local function hit(row, col)
  local c = 0
  for _, span in ipairs(last and last.lines[row] or {}) do
    local n = utf8.len(span.text)
    if col > c and col <= c + n then
      return span.id
    end
    c = c + n
  end
end

local function find(text)
  for r, spans in ipairs(last and last.lines or {}) do
    local parts = {}
    for _, span in ipairs(spans) do
      parts[#parts + 1] = span.text
    end
    local line = table.concat(parts)
    local at = line:find(text, 1, true)
    if at then
      return r, utf8.len(line:sub(1, at - 1)) + 1
    end
  end
end

for line in io.lines() do
  local cmd, rest = line:match("^(%S+)%s?(.*)$")
  if cmd == "size" then
    local a, b = rest:match("(%d+)%s+(%d+)")
    cols, rows = tonumber(a), tonumber(b)
  elseif cmd == "key" then
    view.key(model, st, rest, { width = cols, height = rows })
  elseif cmd == "type" then
    for _, code in utf8.codes(rest) do
      local ch = utf8.char(code)
      view.key(model, st, ch == " " and "space" or ch, { width = cols, height = rows }, ch)
    end
  elseif cmd == "click" or cmd == "clicktext" then
    if not last then
      draw(0)
    end
    local r, c
    if cmd == "click" then
      local a, b = rest:match("(%d+)%s+(%d+)")
      r, c = tonumber(a), tonumber(b)
    else
      r, c = find(rest)
    end
    assert(r, "nothing on screen shows: " .. rest)
    view.click(model, st, hit(r, c), 1)
  elseif cmd == "wheel" then
    local dir, a, b = rest:match("(%a+)%s+(%d+)%s+(%d+)")
    view.scroll(model, st, dir == "up", tonumber(b) - 1, tonumber(a) - 1)
  elseif cmd == "act" then
    local name, spec = rest:match("^(%S+)%s?(.*)$")
    local args = {}
    for pair in (spec or ""):gmatch("[^|]+") do
      local k, v = pair:match("^(%w+)=(.*)$")
      if k then
        args[k] = v
      end
    end
    view.act(model, st, name, args)
  elseif cmd == "threads" then
    local f = assert(io.open(rest))
    view.set_threads(st, threads.parse(f:read("a")))
    f:close()
  elseif cmd == "print" then
    local frame = draw(tonumber(rest) or 0)
    for _, spans in ipairs(frame.lines) do
      local parts = {}
      for _, span in ipairs(spans) do
        parts[#parts + 1] = span.text
      end
      io.write(table.concat(parts), "\n")
    end
  elseif cmd == "render" then
    local frame = draw(tonumber(rest) or 0)
    local texts, flow = {}, {}
    for r, spans in ipairs(frame.lines) do
      local parts, col = {}, 0
      for _, span in ipairs(spans) do
        parts[#parts + 1] = span.text
        if span.st == "flow" then
          flow[#flow + 1] = r .. ":" .. col .. ":" .. span.text
        end
        col = col + utf8.len(span.text)
      end
      texts[r] = table.concat(parts)
    end
    local writes = {}
    for _, w in ipairs(view.take_outbox(st)) do
      writes[#writes + 1] = table.concat(w, "\t")
    end
    io.write(
      '{"rows":',
      json_list(texts),
      ',"flow":',
      json_list(flow),
      ',"status":',
      json_string(frame.status),
      ',"outbox":',
      json_list(writes),
      "}\f\n"
    )
  end
end
