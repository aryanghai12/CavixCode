module github.com/cavix/edge

go 1.26

// Zero third-party dependencies — intentional.
// Cavix must build and run in air-gapped environments, so the edge speaks the
// Redis RESP wire protocol directly via the standard library (internal/resp).
