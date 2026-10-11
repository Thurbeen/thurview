-- The bridge's answer, read back: one record per line, tab-separated, free
-- text hex-encoded (see bridge.mjs). Hex because the plugin sandbox has no
-- JSON decoder and no `load`, and because a hex string needs no shell quoting
-- on the way out either.
local M = {}

function M.hex(s)
  return (s:gsub(".", function(c)
    return string.format("%02x", c:byte())
  end))
end

function M.unhex(h)
  return ((h or ""):gsub("%x%x", function(x)
    return string.char(tonumber(x, 16))
  end))
end

--- { status, revision, threads = { {id, kind, mode, status, submitted, target, key, messages} }, decisions, error }
function M.parse(text)
  local out = { threads = {}, decisions = {} }
  local current
  for line in (text or ""):gmatch("[^\n]+") do
    local f = {}
    for field in (line .. "\t"):gmatch("([^\t]*)\t") do
      f[#f + 1] = field
    end
    if f[1] == "R" then
      out.status, out.revision = f[2], tonumber(f[3])
    elseif f[1] == "T" then
      current = {
        id = f[2],
        kind = f[3],
        mode = f[4],
        status = f[5],
        submitted = f[6] == "1",
        target = f[7],
        key = M.unhex(f[8]),
        revision = tonumber(f[9]),
        messages = {},
      }
      out.threads[#out.threads + 1] = current
    elseif f[1] == "M" and current then
      current.messages[#current.messages + 1] = { role = f[2], body = M.unhex(f[3]) }
    elseif f[1] == "D" then
      out.decisions[#out.decisions + 1] =
        { decision = f[2], revision = tonumber(f[3]), body = M.unhex(f[4]) }
    elseif f[1] == "E" then
      out.error = M.unhex(f[2])
    end
  end
  return out
end

return M
