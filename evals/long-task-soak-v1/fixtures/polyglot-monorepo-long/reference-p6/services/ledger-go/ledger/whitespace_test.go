package ledger

import (
	"strings"
	"testing"
)

func TestAccountIDWhitespace(t *testing.T) {
	for _, bad := range []string{` A-1`, `A-1 `, `\tA-1`, `A-1\n`} {
		payload := strings.Replace(v2, `"account_id":"A-1"`, `"account_id":"`+bad+`"`, 1)
		if got := codeOf(t, payload); got != "INVALID" {
			t.Errorf("%q: got %q", bad, got)
		}
	}
	if got := codeOf(t, strings.Replace(v2, `"account_id":"A-1"`, `"account_id":"A 1"`, 1)); got != "" {
		t.Errorf("inner space should be fine, got %q", got)
	}
}
