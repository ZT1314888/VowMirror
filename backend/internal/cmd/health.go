package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"
)

func Health(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:8000/health", nil)
	if err != nil {
		return err
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return errors.New("后端健康检查连接失败")
	}
	defer response.Body.Close()
	var body struct {
		Code int `json:"code"`
		Data struct {
			Status string `json:"status"`
		} `json:"data"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&body) != nil || body.Code != 0 || body.Data.Status != "ok" {
		return errors.New("后端健康检查响应无效")
	}
	return nil
}
