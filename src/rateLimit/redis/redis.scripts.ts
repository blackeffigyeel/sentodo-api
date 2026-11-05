/**
 * Atomic Lua scripts, one per algorithm. Each runs inside Redis, so the read-refill-check-write
 * sequence cannot interleave with another instance. They use Redis server time (`TIME`) to avoid
 * clock skew between application servers.
 *
 * Every script returns `{ allowed (0|1), remaining (string), retryAfterSeconds (number) }`.
 * `remaining` is a string because Redis truncates Lua floats to integers.
 */

const NOW_MS = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
`;

/** KEYS[1]=key; ARGV: capacity, refillPerSecond, cost. */
export const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
${NOW_MS}
local b = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(b[1])
local last = tonumber(b[2])
if tokens == nil then tokens = capacity; last = now end
tokens = math.min(capacity, tokens + (math.max(0, now - last) / 1000) * rate)
local allowed = 0
if tokens >= cost then tokens = tokens - cost; allowed = 1 end
local retry = 0
if allowed == 0 then retry = math.ceil((cost - tokens) / rate) end
redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('EXPIRE', key, math.ceil(capacity / rate) + 1)
return { allowed, tostring(tokens), retry }
`;

/** KEYS[1]=key; ARGV: capacity, leakPerSecond, cost. */
export const LEAKY_BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
${NOW_MS}
local b = redis.call('HMGET', key, 'level', 'ts')
local level = tonumber(b[1])
local last = tonumber(b[2])
if level == nil then level = 0; last = now end
level = math.max(0, level - (math.max(0, now - last) / 1000) * rate)
local allowed = 0
if level + cost <= capacity then level = level + cost; allowed = 1 end
local retry = 0
if allowed == 0 then retry = math.ceil((level + cost - capacity) / rate) end
redis.call('HSET', key, 'level', tostring(level), 'ts', tostring(now))
redis.call('EXPIRE', key, math.ceil(capacity / rate) + 1)
return { allowed, tostring(capacity - level), retry }
`;

/** KEYS[1]=key prefix; ARGV: limit, windowSeconds, cost. */
export const FIXED_WINDOW_SCRIPT = `
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
${NOW_MS}
local windowMs = window * 1000
local start = math.floor(now / windowMs) * windowMs
local key = KEYS[1] .. ':' .. start
local count = tonumber(redis.call('GET', key)) or 0
local allowed = 0
if count + cost <= limit then
  count = redis.call('INCRBY', key, cost)
  redis.call('PEXPIRE', key, windowMs * 2)
  allowed = 1
end
local retry = 0
if allowed == 0 then retry = math.ceil((start + windowMs - now) / 1000) end
return { allowed, tostring(math.max(0, limit - count)), retry }
`;

/** KEYS[1]=key; ARGV: limit, windowSeconds, cost, uniqueSuffix. */
export const SLIDING_WINDOW_LOG_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local suffix = ARGV[4]
${NOW_MS}
local windowMs = window * 1000
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - windowMs)
local count = redis.call('ZCARD', key)
local allowed = 0
local retry = 0
if count + cost <= limit then
  for i = 1, cost do
    redis.call('ZADD', key, now, now .. ':' .. suffix .. ':' .. i)
  end
  redis.call('PEXPIRE', key, windowMs + 1000)
  count = count + cost
  allowed = 1
else
  local index = math.max(0, math.min(count - 1, count + cost - limit - 1))
  local oldest = redis.call('ZRANGE', key, index, index, 'WITHSCORES')
  local releasing = tonumber(oldest[2]) or now
  retry = math.max(1, math.ceil((releasing + windowMs - now) / 1000))
end
return { allowed, tostring(math.max(0, limit - count)), retry }
`;

/** KEYS[1]=key prefix; ARGV: limit, windowSeconds, cost. */
export const SLIDING_WINDOW_COUNTER_SCRIPT = `
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
${NOW_MS}
local windowMs = window * 1000
local start = math.floor(now / windowMs) * windowMs
local currentKey = KEYS[1] .. ':' .. start
local previousKey = KEYS[1] .. ':' .. (start - windowMs)
local current = tonumber(redis.call('GET', currentKey)) or 0
local previous = tonumber(redis.call('GET', previousKey)) or 0
local fraction = (now - start) / windowMs
local weighted = previous * (1 - fraction) + current
local allowed = 0
if weighted + cost <= limit then
  redis.call('INCRBY', currentKey, cost)
  redis.call('PEXPIRE', currentKey, windowMs * 3)
  weighted = weighted + cost
  allowed = 1
end
local retry = 0
if allowed == 0 then retry = math.max(1, math.ceil((start + windowMs - now) / 1000)) end
return { allowed, tostring(math.max(0, math.floor(limit - weighted))), retry }
`;
