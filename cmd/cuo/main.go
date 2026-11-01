package main

import (
	"cuo.local/cuo/internal/agent"
	"cuo.local/cuo/internal/backup"
	"cuo.local/cuo/internal/core"
	"log"
	"os"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "backup" {
		if len(os.Args) != 3 || (os.Args[2] != "verify" && os.Args[2] != "restore") {
			log.Fatal("usage: cuo backup verify|restore < backup.tar.gz")
		}
		if err := backup.Run(os.Stdin, os.Args[2] == "restore", "/"); err != nil {
			log.Fatal(err)
		}
		log.Print("Backup archive, database schemas/integrity and Agent JSON checked")
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "agent" {
		log.Fatal(agent.Run())
	}
	log.Fatal(core.Run())
}
