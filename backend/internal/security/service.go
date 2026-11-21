package security

import (
	"context"
	"fmt"
	"os"
	"strconv"
)

type Service struct {
	Config             *SecurityConfig
	TokenStore         *TokenStore
	RateLimiter        *RateLimiter
	Usage              *UsageLedger
	ConcurrencyManager *ConcurrencyManager
}

func InitService(ctx context.Context) (*Service, error) {
	cfg, err := LoadSecurityConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("加载安全配置失败: %w", err)
	}

	tokenStore, err := NewTokenStore(cfg.AuthRequired, cfg.APIKeysEnv)
	if err != nil {
		return nil, err
	}

	if !cfg.AuthRequired || cfg.Concurrency.PerPrincipal != 1 {
		return nil, fmt.Errorf("生成码必须启用鉴权，且每码并发必须为 1")
	}
	dailyLimit := DefaultDailyAttemptLimit
	if value := os.Getenv("TRYON_DAILY_ATTEMPT_LIMIT"); value != "" {
		dailyLimit, err = strconv.Atoi(value)
		if err != nil || dailyLimit <= 0 {
			return nil, fmt.Errorf("TRYON_DAILY_ATTEMPT_LIMIT 必须为正整数")
		}
	}
	path := os.Getenv("TRYON_USAGE_DB")
	if path == "" {
		path = "/var/lib/vowmirror/usage.sqlite"
	}
	usage, err := OpenUsageLedger(path, dailyLimit)
	if err != nil {
		return nil, err
	}
	s := &Service{
		Config:             cfg,
		TokenStore:         tokenStore,
		RateLimiter:        NewRateLimiter(cfg.RateLimit.RequestsPerMinute, cfg.RateLimit.Burst, cfg.RateLimit.LimiterIdleMinutes),
		Usage:              usage,
		ConcurrencyManager: NewConcurrencyManager(cfg.Concurrency.Global, cfg.Concurrency.PerPrincipal),
	}
	return s, nil
}
