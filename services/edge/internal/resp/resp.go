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
	"crypto/tls"
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

// Options configures a connection. Managed Redis (Redis Cloud, Render Key Value,
// Upstash) over the public internet requires a password and usually TLS.
type Options struct {
	Username string
	Password string
	TLS      bool
	Timeout  time.Duration
}

// Dial connects to addr ("host:port") with a timeout (plain, no auth).
func Dial(addr string, timeout time.Duration) (*Client, error) {
	return DialWithOptions(addr, Options{Timeout: timeout})
}

// DialWithOptions connects with optional TLS + AUTH. AUTH is sent first, before any
// other command, exactly as Redis requires.
func DialWithOptions(addr string, opts Options) (*Client, error) {
	timeout := opts.Timeout
	if timeout == 0 {
		timeout = 5 * time.Second
	}
	var conn net.Conn
	var err error
	if opts.TLS {
		host, _, splitErr := net.SplitHostPort(addr)
		if splitErr != nil {
			host = addr
		}
		conn, err = tls.DialWithDialer(&net.Dialer{Timeout: timeout}, "tcp", addr, &tls.Config{ServerName: host})
	} else {
		conn, err = net.DialTimeout("tcp", addr, timeout)
	}
	if err != nil {
		return nil, fmt.Errorf("resp dial %s: %w", addr, err)
	}
	c := &Client{
		conn: conn,
		r:    bufio.NewReader(conn),
		w:    bufio.NewWriter(conn),
	}
	if opts.Password != "" {
		_ = c.SetDeadline(time.Now().Add(timeout))
		var authErr error
		if opts.Username != "" {
			_, authErr = c.Do("AUTH", opts.Username, opts.Password)
		} else {
			_, authErr = c.Do("AUTH", opts.Password)
		}
		_ = c.SetDeadline(time.Time{})
		if authErr != nil {
			_ = c.Close()
			return nil, fmt.Errorf("resp auth: %w", authErr)
		}
	}
	return c, nil
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
