package ratelimit

import "time"

// Decision is the outcome of one request against a limiter.
type Decision struct {
	Allowed    bool
	Limit      int           // the limiter's configured limit (capacity / requests per window)
	Remaining  int           // requests still allowed right now, after this one
	RetryAfter time.Duration // when denied: how long until a request would be allowed; 0 otherwise
}

// Limiter decides one request at a time. Implementations are safe for
// concurrent use.
type Limiter interface {
	Allow() Decision
}
