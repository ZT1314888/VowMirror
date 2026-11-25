package cmd

import (
	"context"
	"errors"
	"fmt"

	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/net/ghttp"
	"github.com/gogf/gf/v2/os/gcfg"

	"backend/internal/catalog"
	"backend/internal/logic/tryon"
	"backend/internal/middleware"
	"backend/internal/security"
)

const ConfigTemplate = "manifest/config/config.example.yaml"
const ServerAddress = ":8000"
const WeddingManifestPath = "/assets/wedding/manifest.json"

func LoadConfig(ctx context.Context) error {
	adapter, err := gcfg.NewAdapterFile(ConfigTemplate)
	if err != nil {
		return fmt.Errorf("加载配置模板失败: %w", err)
	}
	if !adapter.Available(ctx) {
		return fmt.Errorf("缺少配置模板 %s", ConfigTemplate)
	}
	g.Cfg().SetAdapter(adapter)
	return nil
}

func NewApplication(ctx context.Context, name string) (*Application, error) {
	return newApplication(ctx, name, func() (*catalog.Manifest, error) {
		return catalog.LoadManifest(WeddingManifestPath)
	})
}

func newApplication(ctx context.Context, name string, loadManifest func() (*catalog.Manifest, error)) (_ *Application, err error) {
	if err := LoadConfig(ctx); err != nil {
		return nil, err
	}
	manifest, err := loadManifest()
	if err != nil {
		return nil, fmt.Errorf("加载婚礼素材快照失败: %w", err)
	}
	snapshot, err := catalog.NewSnapshot(manifest)
	if err != nil {
		return nil, fmt.Errorf("校验婚礼素材快照失败: %w", err)
	}
	// Missing access tokens fail startup; health itself remains public.
	securityService, err := security.InitService(ctx)
	if err != nil {
		return nil, err
	}
	transport, err := newModelTransport()
	if err != nil {
		return nil, errors.Join(err, securityService.Close())
	}
	defer func() {
		if err != nil {
			err = errors.Join(err, securityService.Close())
			transport.CloseIdleConnections()
		}
	}()
	coupleService, err := generationService(snapshot, securityService, transport)
	if err != nil {
		return nil, err
	}
	s := g.Server(name)
	if err := s.SetConfigWithMap(g.Map{"GracefulShutdownTimeout": gracefulShutdownSeconds}); err != nil {
		return nil, err
	}
	s.SetAddr(ServerAddress)
	// The route enforces 24 MiB; GoFrame's default 8 MiB wrapper rejects valid requests.
	s.SetClientMaxBodySize(0)
	// GoFrame wraps ResponseWriter without exposing per-request deadline controls.
	// Socket deadlines bound uploads and writes; the service context bounds model processing.
	s.SetReadTimeout(tryon.RequestTimeout)
	s.SetWriteTimeout(tryon.StreamWriteTimeout)
	s.SetDumpRouterMap(false)
	s.Group("/", func(group *ghttp.RouterGroup) {
		group.Middleware(middleware.RequestID)
		group.GET("/health", func(r *ghttp.Request) {
			r.Response.Header().Set("Cache-Control", "no-store")
			r.Response.WriteJson(g.Map{"code": 0, "message": "", "data": g.Map{"status": "ok"}})
		})
		group.Group("/catalog", func(catalogGroup *ghttp.RouterGroup) {
			catalogGroup.GET("/outfits", func(r *ghttp.Request) {
				r.Response.Header().Set("Cache-Control", "no-store")
				r.Response.WriteJson(g.Map{"code": 0, "message": "", "data": snapshot.PublicDirectory()})
			})
		})
		group.Group("/tryon", func(generationGroup *ghttp.RouterGroup) {
			generationGroup.Middleware(middleware.NewAuthMiddleware(securityService.TokenStore).Handler)
			generationGroup.Middleware(middleware.NewRateLimitMiddleware(securityService.RateLimiter).Handler)
			generationGroup.Middleware(middleware.NewBodyLimitMiddleware(tryon.MaxBodyBytes).Handler)
			generationGroup.POST("/authorize", authorizeHandler(securityService.Usage))
			generationGroup.POST("/couple", coupleHandler(coupleService))
		})
	})
	return trackServer(s, securityService, transport), nil
}
