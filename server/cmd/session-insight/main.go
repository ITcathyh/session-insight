// session-insight is a privacy-preserving local UI/API for Codex and Claude sessions.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/ITcathyh/session-insight/server/internal/sessionstore"
)

const shutdownWindow = 30 * time.Second

func main() {
	addr := flag.String("addr", "127.0.0.1:4788", "loopback address to listen on")
	data := flag.String("data", "", "path to local JSON index")
	web := flag.String("web", "", "directory containing the static web application")
	flag.Parse()
	if !isLoopbackAddr(*addr) {
		log.Fatal("--addr must use a loopback host")
	}
	if *data != "" {
		*data = filepath.Clean(*data)
	}
	explorer, err := sessionstore.New(sessionstore.Config{DataFile: *data, WebDir: *web})
	if err != nil {
		log.Fatal(err)
	}
	listener, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Fprintf(os.Stderr, "Session Insight listening on http://%s\n", listener.Addr())
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := serveUntilSignal(ctx, listener, explorer.Handler()); err != nil {
		log.Fatal(err)
	}
}

// serveUntilSignal stops accepting connections on Ctrl-C/TERM, then waits for
// in-flight requests (including upload handlers and their cleanup defers).
func serveUntilSignal(ctx context.Context, listener net.Listener, handler http.Handler) error {
	server := &http.Server{Handler: handler}
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.Serve(listener) }()
	select {
	case err := <-serveErr:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownWindow)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("graceful shutdown: %w", err)
		}
		if err := <-serveErr; err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	}
}

func isLoopbackAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
