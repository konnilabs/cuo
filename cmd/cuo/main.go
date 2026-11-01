package main

import (
	"cuo.local/cuo/internal/agent"
	"cuo.local/cuo/internal/core"
	"log"
	"os"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "agent" {
		log.Fatal(agent.Run())
	}
	log.Fatal(core.Run())
}
