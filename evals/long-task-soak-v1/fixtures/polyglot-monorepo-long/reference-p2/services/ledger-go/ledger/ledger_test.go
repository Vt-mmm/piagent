package ledger

import (
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestProcessSample(t *testing.T) {
	file, err := os.Open("../testdata/events-sample.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	report, err := Process(file)
	if err != nil {
		t.Fatal(err)
	}
	want := Report{
		Accepted: 3,
		Balances: []Balance{{"A-1", "USD", 3597}, {"A-2", "VND", 128250}},
		Rejected: []Rejection{{4, "EV-2", "DUPLICATE"}, {5, "", "BAD_JSON"}, {6, "EV-9", "UNKNOWN_TYPE"}, {8, "EV-10", "INVALID"}},
	}
	if !reflect.DeepEqual(report, want) {
		t.Fatalf("got %+v\nwant %+v", report, want)
	}
}

func TestProcessEmpty(t *testing.T) {
	report, err := Process(strings.NewReader("\n  \n"))
	if err != nil || report.Accepted != 0 || len(report.Balances) != 0 || len(report.Rejected) != 0 {
		t.Fatalf("got %+v %v", report, err)
	}
}
