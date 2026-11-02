package main

import (
	"cuo.local/cuo/internal/agent"
	"cuo.local/cuo/internal/backup"
	"cuo.local/cuo/internal/core"
	"cuo.local/cuo/internal/provision"
	"flag"
	"log"
	"os"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "provision" {
		args := flag.NewFlagSet("provision", flag.ExitOnError)
		dir := args.String("directory", "/setup", "private installation directory")
		host := args.String("registry-host", "localhost:5055", "canonical local registry host")
		registry := args.Bool("registry", false, "initialize Zot configuration")
		owner := args.Int("owner-uid", 1000, "host UID for the CI credential file")
		_ = args.Parse(os.Args[2:])
		if err := provision.Setup(*dir, *host, *registry, *owner); err != nil {
			log.Fatal(err)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "backup" {
		if len(os.Args) == 3 && os.Args[2] == "create" {
			if err := backup.Create(os.Stdout, "/"); err != nil {
				log.Fatal(err)
			}
			return
		}
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
