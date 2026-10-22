package ratelimit

import "time"

// Keyed keeps one limiter per key (client).
// TODO: not implemented yet (SPEC.md §3).
type Keyed struct{}

func NewKeyed(newLimiter func() Limiter, clock Clock, idleTTL time.Duration) *Keyed {
	return &Keyed{}
}

func (k *Keyed) Allow(key string) Decision { return Decision{} }

func (k *Keyed) Len() int { return 0 }

func (k *Keyed) Sweep() int { return 0 }
