package middleware

import (
	"context"

	"github.com/gogf/gf/v2/net/ghttp"
)

func RequestID(r *ghttp.Request) {
	// Correlation IDs are server-generated so untrusted headers never enter responses or logs.
	reqID := GenerateRequestID()
	r.Response.Header().Set("X-Request-ID", reqID)
	r.SetCtxVar(CtxRequestID, reqID)
	ctx := context.WithValue(r.Context(), CtxRequestID, reqID)
	r.SetCtx(ctx)

	r.Middleware.Next()
}
