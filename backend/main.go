package main

import (
	"context"
	"log"

	"backend/internal/cmd"
)

func main() {
	server, err := cmd.NewServer(context.Background(), "vowmirror")
	if err != nil {
		log.Fatal(err)
	}
	server.Run()
}
