package ratelimit

import "time"

// SlidingWindow allows at most limit requests in any window-long period.
// TODO: not implemented yet (SPEC.md §2).
type SlidingWindow struct{}

func NewSlidingWindow(limit int, window time.Duration, clock Clock) *SlidingWindow {
	return &SlidingWindow{}
}

func (w *SlidingWindow) Allow() Decision { return Decision{} }
