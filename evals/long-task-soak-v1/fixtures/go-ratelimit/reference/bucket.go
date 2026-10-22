package ratelimit

import (
	"math"
	"sync"
	"time"
)

// TokenBucket holds up to capacity tokens and refills continuously at rate
// tokens per second. Each allowed request takes one token. It starts full.
type TokenBucket struct {
	mu       sync.Mutex
	clock    Clock
	capacity int
	rate     float64
	tokens   float64
	last     time.Time
}

func NewTokenBucket(capacity int, ratePerSecond float64, clock Clock) *TokenBucket {
	if capacity < 1 || ratePerSecond <= 0 {
		panic("ratelimit: capacity must be >= 1 and rate > 0")
	}
	return &TokenBucket{clock: clock, capacity: capacity, rate: ratePerSecond, tokens: float64(capacity), last: clock.Now()}
}

// refill adds the tokens earned since the last refill, fractions included,
// so frequent calls never lose time.
func (b *TokenBucket) refill() {
	now := b.clock.Now()
	if elapsed := now.Sub(b.last); elapsed > 0 {
		b.tokens = math.Min(float64(b.capacity), b.tokens+elapsed.Seconds()*b.rate)
	}
	b.last = now
}

// Tokens reports the tokens available now (after refill), fractions included.
func (b *TokenBucket) Tokens() float64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.refill()
	return b.tokens
}

func (b *TokenBucket) Allow() Decision {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.refill()
	if b.tokens >= 1 {
		b.tokens--
		return Decision{Allowed: true, Limit: b.capacity, Remaining: int(math.Floor(b.tokens))}
	}
	wait := (1 - b.tokens) / b.rate * float64(time.Second)
	return Decision{Allowed: false, Limit: b.capacity, Remaining: 0, RetryAfter: time.Duration(math.Ceil(wait))}
}
