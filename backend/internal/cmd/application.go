package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/gogf/gf/v2/net/ghttp"
)

const gracefulShutdownSeconds = 100
const modelIdleConnectionsPerHost = 4
const resourceDrainSlack = 5 * time.Second

type Application struct {
	*ghttp.Server
	ledger    io.Closer
	transport *http.Transport
	requests  *activeRequests
	closeOnce sync.Once
	closeErr  error
}

func trackServer(server *ghttp.Server, ledger io.Closer, transport *http.Transport) *Application {
	requests := &activeRequests{done: make(chan struct{})}
	server.SetHandler(requests.wrap(server.GetHandler()))
	return &Application{Server: server, ledger: ledger, transport: transport, requests: requests}
}

func newModelTransport() (*http.Transport, error) {
	defaults, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		return nil, fmt.Errorf("默认 HTTP transport 类型无效")
	}
	transport := defaults.Clone()
	transport.MaxIdleConnsPerHost = modelIdleConnectionsPerHost
	return transport, nil
}

func (a *Application) Run() error {
	// Bind explicitly so a port conflict returns an error instead of framework Fatalf.
	listener, err := net.Listen("tcp", ServerAddress)
	if err != nil {
		return errors.Join(err, a.closeResources())
	}
	if err := a.Server.SetListener(listener); err != nil {
		return errors.Join(err, listener.Close(), a.closeResources())
	}
	if err := a.Server.Start(); err != nil {
		return errors.Join(err, listener.Close(), a.closeResources())
	}
	ghttp.Wait()
	return a.finishShutdown(resourceDrainSlack)
}

// Shutdown supports explicit/test shutdown; production SIGTERM uses GoFrame's
// graceful listener shutdown. Both paths wait for the complete HTTP handler.
func (a *Application) Shutdown() error {
	return errors.Join(a.Server.Shutdown(), a.finishShutdown(gracefulShutdownSeconds*time.Second))
}

func (a *Application) finishShutdown(timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if err := a.requests.drain(ctx); err != nil {
		return err
	}
	return a.closeResources()
}

func (a *Application) closeResources() error {
	a.closeOnce.Do(func() {
		a.closeErr = a.ledger.Close()
		a.transport.CloseIdleConnections()
	})
	return a.closeErr
}

type activeRequests struct {
	mu       sync.Mutex
	count    int
	draining bool
	done     chan struct{}
}

func (a *activeRequests) wrap(handler func(http.ResponseWriter, *http.Request)) func(http.ResponseWriter, *http.Request) {
	return func(writer http.ResponseWriter, request *http.Request) {
		a.mu.Lock()
		if a.draining {
			a.mu.Unlock()
			http.Error(writer, "server is shutting down", http.StatusServiceUnavailable)
			return
		}
		a.count++
		a.mu.Unlock()
		defer a.complete()
		handler(writer, request)
	}
}

func (a *activeRequests) complete() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.count--
	if a.draining && a.count == 0 {
		close(a.done)
	}
}

func (a *activeRequests) drain(ctx context.Context) error {
	a.mu.Lock()
	if !a.draining {
		a.draining = true
		if a.count == 0 {
			close(a.done)
		}
	}
	a.mu.Unlock()
	select {
	case <-a.done:
		return nil
	case <-ctx.Done():
		return errors.New("等待完整请求及记账结束超时")
	}
}
