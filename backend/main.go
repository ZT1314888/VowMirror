package main

import (
	"context"
	"log"
	"os"

	"backend/internal/cmd"
)

func main() {
	if len(os.Args) > 1 {
		if len(os.Args) != 2 || os.Args[1] != "health" {
			log.Fatal("仅支持 health 子命令")
		}
		if err := cmd.Health(context.Background()); err != nil {
			log.Fatal(err)
		}
		return
	}
	server, err := cmd.NewApplication(context.Background(), "vowmirror")
	if err != nil {
		log.Fatal(err)
	}
	if err := server.Run(); err != nil {
		log.Fatal(err)
	}
}
