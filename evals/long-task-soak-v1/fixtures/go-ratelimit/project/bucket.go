package ratelimit

import (
	"math"
	"sync"
	"time"
)

// TokenBucket holds up to capacity tokens and refills at rate tokens per
// second. Each allowed request takes one token. It starts full.
type TokenBucket struct {
	mu       sync.Mutex
	clock    Clock
	capacity int
	rate     float64
	tokens   int
	last     time.Time
}

func NewTokenBucket(capacity int, ratePerSecond float64, clock Clock) *TokenBucket {
	if capacity < 1 || ratePerSecond <= 0 {
		panic("ratelimit: capacity must be >= 1 and rate > 0")
	}
	return &TokenBucket{clock: clock, capacity: capacity, rate: ratePerSecond, tokens: capacity, last: clock.Now()}
}

func (b *TokenBucket) refill() {
	now := b.clock.Now()
	elapsed := now.Sub(b.last)
	b.tokens += int(elapsed.Seconds() * b.rate)
	if b.tokens > b.capacity {
		b.tokens = b.capacity
	}
	b.last = now
}

// Tokens reports the tokens available now (after refill).
func (b *TokenBucket) Tokens() float64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.refill()
	return float64(b.tokens)
}

func (b *TokenBucket) Allow() Decision {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.refill()
	if b.tokens >= 1 {
		b.tokens--
		return Decision{Allowed: true, Limit: b.capacity, Remaining: b.tokens}
	}
	wait := (1 - float64(b.tokens)) / b.rate * float64(time.Second)
	return Decision{Allowed: false, Limit: b.capacity, Remaining: 0, RetryAfter: time.Duration(math.Ceil(wait))}
}
