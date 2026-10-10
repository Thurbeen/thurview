-- Drives the terminal pane's view outside thurbox, in the same Lua 5.4 the host
-- embeds. The script on stdin is one command per line:
--
--   size <cols> <rows>   the rect the pane is handed
--   key <name>           a key as thurbox names it (j, tab, right, space, ])
--   render <elapsed>     draw one frame at that animation clock, in seconds
--
-- Each render prints one JSON frame, terminated by a form feed: the rows as
-- plain text, the cells painted in the flow highlight, and the status line.
local ui = assert(arg[1], "usage: lua5.4 terminal-poc-drive.lua <ui dir>")
package.path = ui .. "/?.lua;" .. package.path

local view = require("thurview_poc.view")
local model = require("thurview_poc.model")

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

for line in io.lines() do
  local cmd, a, b = line:match("^(%S+)%s*(%S*)%s*(%S*)")
  if cmd == "size" then
    cols, rows = tonumber(a), tonumber(b)
  elseif cmd == "key" then
    view.key(model, st, a, { width = cols, height = rows })
  elseif cmd == "render" then
    local frame = view.render(model, st, { width = cols, height = rows, elapsed = tonumber(a) })
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
    io.write(
      '{"rows":',
      json_list(texts),
      ',"flow":',
      json_list(flow),
      ',"status":',
      json_string(frame.status),
      "}\f\n"
    )
  end
end
