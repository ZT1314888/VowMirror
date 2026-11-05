package cmd

import (
	"context"
	"fmt"

	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/net/ghttp"
	"github.com/gogf/gf/v2/os/gcfg"

	"backend/internal/middleware"
	"backend/internal/security"
)

const ConfigTemplate = "manifest/config/config.example.yaml"
const ServerAddress = ":8000"

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

func NewServer(ctx context.Context, name string) (*ghttp.Server, error) {
	if err := LoadConfig(ctx); err != nil {
		return nil, err
	}
	// Missing access tokens fail startup; health itself remains public.
	// Future business routes will receive this service explicitly.
	if _, err := security.InitService(ctx); err != nil {
		return nil, err
	}
	s := g.Server(name)
	s.SetAddr(ServerAddress)
	s.SetDumpRouterMap(false)
	s.Group("/", func(group *ghttp.RouterGroup) {
		group.Middleware(middleware.RequestID)
		group.GET("/health", func(r *ghttp.Request) {
			r.Response.Header().Set("Cache-Control", "no-store")
			r.Response.WriteJson(g.Map{"code": 0, "message": "", "data": g.Map{"status": "ok"}})
		})
	})
	return s, nil
}
