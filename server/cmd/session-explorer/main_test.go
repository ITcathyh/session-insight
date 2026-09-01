package main

import (
	"context"
	"net"
	"net/http"
	"testing"
	"time"
)

func TestServeUntilSignalWaitsForActiveHandlerCleanup(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started, release, cleaned := make(chan struct{}), make(chan struct{}), make(chan struct{})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(cleaned)
		close(started)
		<-release
		w.WriteHeader(http.StatusNoContent)
	})
	done := make(chan error, 1)
	go func() { done <- serveUntilSignal(ctx, listener, handler) }()
	clientDone := make(chan struct{})
	go func() {
		defer close(clientDone)
		response, err := http.Get("http://" + listener.Addr().String())
		if err == nil {
			response.Body.Close()
		}
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("handler did not start")
	}
	cancel()
	select {
	case err := <-done:
		t.Fatalf("shutdown returned before handler cleanup: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	select {
	case <-cleaned:
	case <-time.After(time.Second):
		t.Fatal("handler cleanup did not run")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("server did not stop")
	}
	select {
	case <-clientDone:
	case <-time.After(time.Second):
		t.Fatal("client did not finish")
	}
}
