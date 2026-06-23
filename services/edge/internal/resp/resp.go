// Package resp is a minimal Redis RESP (v2) client built on the standard library
// only. It exists so the edge has ZERO third-party dependencies and therefore
// builds and runs in air-gapped environments — a hard product requirement.
//
// It implements just enough of the protocol for the edge's needs: send a
// command as an array of bulk strings, parse one reply. Supported reply types:
// simple string (+), error (-), integer (:), bulk string ($, incl. null), and
// array (*). That covers PING, XADD, and SET NX EX.
package resp

import (
	"bufio"
	"errors"
	"fmt"
	"net"
	"strconv"
	"time"
)

// Client is a single-connection RESP client. Not safe for concurrent use; wrap
// with a pool or a mutex if shared. The edge uses one per goroutine / serializes.
type Client struct {
	conn net.Conn
	r    *bufio.Reader
	w    *bufio.Writer
}

// Dial connects to addr ("host:port") with a timeout.
func Dial(addr string, timeout time.Duration) (*Client, error) {
	conn, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return nil, fmt.Errorf("resp dial %s: %w", addr, err)
	}
	return &Client{
		conn: conn,
		r:    bufio.NewReader(conn),
		w:    bufio.NewWriter(conn),
	}, nil
}

// Close closes the underlying connection.
func (c *Client) Close() error { return c.conn.Close() }

// Do sends one command and returns the parsed reply. A RESP error reply (-ERR …)
// is returned as a Go error. Reply Go types: string (simple/bulk), int64
// (integer), nil (null bulk), []any (array).
func (c *Client) Do(args ...string) (any, error) {
	if err := c.writeCommand(args); err != nil {
		return nil, err
	}
	if err := c.w.Flush(); err != nil {
		return nil, err
	}
	return c.readReply()
}

// SetDeadline bounds a single round trip so a stalled Redis cannot block the
// edge's request goroutine indefinitely.
func (c *Client) SetDeadline(t time.Time) error { return c.conn.SetDeadline(t) }

func (c *Client) writeCommand(args []string) error {
	if _, err := fmt.Fprintf(c.w, "*%d\r\n", len(args)); err != nil {
		return err
	}
	for _, a := range args {
		if _, err := fmt.Fprintf(c.w, "$%d\r\n", len(a)); err != nil {
			return err
		}
		if _, err := c.w.WriteString(a); err != nil {
			return err
		}
		if _, err := c.w.WriteString("\r\n"); err != nil {
			return err
		}
	}
	return nil
}

func (c *Client) readReply() (any, error) {
	line, err := c.readLine()
	if err != nil {
		return nil, err
	}
	if len(line) == 0 {
		return nil, errors.New("resp: empty reply line")
	}
	prefix, rest := line[0], line[1:]
	switch prefix {
	case '+': // simple string
		return rest, nil
	case '-': // error
		return nil, fmt.Errorf("resp error: %s", rest)
	case ':': // integer
		return strconv.ParseInt(rest, 10, 64)
	case '$': // bulk string
		n, err := strconv.Atoi(rest)
		if err != nil {
			return nil, fmt.Errorf("resp: bad bulk length %q: %w", rest, err)
		}
		if n < 0 {
			return nil, nil // null bulk
		}
		buf := make([]byte, n+2) // include trailing CRLF
		if _, err := readFull(c.r, buf); err != nil {
			return nil, err
		}
		return string(buf[:n]), nil
	case '*': // array
		n, err := strconv.Atoi(rest)
		if err != nil {
			return nil, fmt.Errorf("resp: bad array length %q: %w", rest, err)
		}
		if n < 0 {
			return nil, nil
		}
		arr := make([]any, n)
		for i := 0; i < n; i++ {
			arr[i], err = c.readReply()
			if err != nil {
				return nil, err
			}
		}
		return arr, nil
	default:
		return nil, fmt.Errorf("resp: unknown reply type %q", string(prefix))
	}
}

// readLine reads through the next CRLF and returns the line without it.
func (c *Client) readLine() (string, error) {
	s, err := c.r.ReadString('\n')
	if err != nil {
		return "", err
	}
	// strip trailing \r\n (or \n)
	s = trimCRLF(s)
	return s, nil
}

func trimCRLF(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}

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
