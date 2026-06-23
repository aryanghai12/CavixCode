package queue

import (
	"bufio"
	"context"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/cavix/edge/internal/canonical"
)

// fakeRedis is a loopback TCP server that speaks just enough RESP to accept one
// XADD and reply with a stream entry ID. It lets us test the real wire encoding
// of RedisStreamProducer without a running Redis (fully hermetic).
type fakeRedis struct {
	ln       net.Listener
	gotArgs  []string
	gotReady chan struct{}
}

func startFakeRedis(t *testing.T) *fakeRedis {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	f := &fakeRedis{ln: ln, gotReady: make(chan struct{})}
	go f.serve()
	t.Cleanup(func() { _ = ln.Close() })
	return f
}

func (f *fakeRedis) addr() string { return f.ln.Addr().String() }

func (f *fakeRedis) serve() {
	conn, err := f.ln.Accept()
	if err != nil {
		return
	}
	defer conn.Close()
	r := bufio.NewReader(conn)

	// Parse one RESP array of bulk strings (the command).
	line, _ := r.ReadString('\n')
	if !strings.HasPrefix(line, "*") {
		return
	}
	n := atoi(strings.TrimSpace(line[1:]))
	args := make([]string, 0, n)
	for i := 0; i < n; i++ {
		hdr, _ := r.ReadString('\n') // $len
		l := atoi(strings.TrimSpace(hdr[1:]))
		buf := make([]byte, l+2) // value + CRLF
		_, _ = readFull(r, buf)
		args = append(args, string(buf[:l]))
	}
	f.gotArgs = args
	close(f.gotReady)

	// Reply with a bulk-string stream ID, as real XADD does.
	_, _ = conn.Write([]byte("$15\r\n1700000000000-0\r\n"))
}

func TestRedisStreamProducer_XADDWireFormat(t *testing.T) {
	f := startFakeRedis(t)
	p, err := NewRedisStreamProducer(f.addr(), "cavix:reviewjobs", 2*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer p.Close()

	job := canonical.ReviewJob{
		SchemaVersion: "1", Repo: "acme/widget", PRNumber: 7, HeadSHA: "abc",
		IdempotencyKey: "key-1",
	}
	id, err := p.Enqueue(context.Background(), job)
	if err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	if id != "1700000000000-0" {
		t.Fatalf("returned id = %q, want the stream entry id", id)
	}

	select {
	case <-f.gotReady:
	case <-time.After(2 * time.Second):
		t.Fatal("fake redis never received the command")
	}

	// Expect: XADD cavix:reviewjobs * job <json>
	if len(f.gotArgs) != 5 {
		t.Fatalf("got %d args, want 5: %v", len(f.gotArgs), f.gotArgs)
	}
	if f.gotArgs[0] != "XADD" || f.gotArgs[1] != "cavix:reviewjobs" || f.gotArgs[2] != "*" || f.gotArgs[3] != "job" {
		t.Fatalf("command framing wrong: %v", f.gotArgs[:4])
	}
	if !strings.Contains(f.gotArgs[4], `"repo":"acme/widget"`) || !strings.Contains(f.gotArgs[4], `"idempotency_key":"key-1"`) {
		t.Fatalf("job payload not the canonical JSON: %s", f.gotArgs[4])
	}
}

func atoi(s string) int {
	n := 0
	neg := false
	for i, c := range s {
		if i == 0 && c == '-' {
			neg = true
			continue
		}
		if c < '0' || c > '9' {
			break
		}
		n = n*10 + int(c-'0')
	}
	if neg {
		return -n
	}
	return n
}

// readFull is duplicated minimally here to read an exact byte count from the
// bufio.Reader in the fake server.
func readFull(r *bufio.Reader, buf []byte) (int, error) {
	total := 0
	for total < len(buf) {
		n, err := r.Read(buf[total:])
		total += n
		if err != nil {
			return total, err
		}
	}
	return total, nil
}
