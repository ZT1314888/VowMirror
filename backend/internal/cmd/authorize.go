package cmd

import (
	"backend/internal/logic/tryon"
	"backend/internal/middleware"
	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/net/ghttp"
)

func authorizeHandler(usage tryon.Usage) func(*ghttp.Request) {
	return func(r *ghttp.Request) {
		r.Response.Header().Set("Cache-Control", "no-store")
		remaining, apiError := usage.Check(r.Context(), r.GetCtxVar(middleware.CtxPrincipalID).String())
		if apiError != nil {
			middleware.WriteAPIError(r, apiError)
			return
		}
		r.Response.WriteJson(g.Map{"code": 0, "message": "", "data": g.Map{"remaining": remaining}})
	}
}
