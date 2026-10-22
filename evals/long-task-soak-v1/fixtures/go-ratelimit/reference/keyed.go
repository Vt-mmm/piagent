package ratelimit

import (
	"sync"
	"time"
)

type keyedEntry struct {
	limiter  Limiter
	lastSeen time.Time
}

// Keyed keeps one limiter per key (client) and forgets idle keys on Sweep.
type Keyed struct {
	mu         sync.Mutex
	newLimiter func() Limiter
	clock      Clock
	idleTTL    time.Duration
	entries    map[string]*keyedEntry
}

func NewKeyed(newLimiter func() Limiter, clock Clock, idleTTL time.Duration) *Keyed {
	return &Keyed{newLimiter: newLimiter, clock: clock, idleTTL: idleTTL, entries: map[string]*keyedEntry{}}
}

func (k *Keyed) Allow(key string) Decision {
	k.mu.Lock()
	entry, ok := k.entries[key]
	if !ok {
		entry = &keyedEntry{limiter: k.newLimiter()}
		k.entries[key] = entry
	}
	entry.lastSeen = k.clock.Now()
	k.mu.Unlock()
	return entry.limiter.Allow()
}

func (k *Keyed) Len() int {
	k.mu.Lock()
	defer k.mu.Unlock()
	return len(k.entries)
}

func (k *Keyed) Sweep() int {
	if k.idleTTL <= 0 {
		return 0
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	now, removed := k.clock.Now(), 0
	for key, entry := range k.entries {
		if now.Sub(entry.lastSeen) >= k.idleTTL {
			delete(k.entries, key)
			removed++
		}
	}
	return removed
}
