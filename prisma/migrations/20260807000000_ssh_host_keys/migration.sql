-- SSH server host-key pins (trust-on-first-use).
--
-- Backs SshConfig.verifyHostKey, which is opt-in and defaults OFF, so this
-- table simply starts empty on every existing install and nothing changes
-- until an operator ticks the box on a credential.
CREATE TABLE "ssh_host_keys" (
    "id" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "keyType" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ssh_host_keys_pkey" PRIMARY KEY ("id")
);

-- One pin per dialed endpoint; the upsert in sshHostKeyService keys on this.
CREATE UNIQUE INDEX "ssh_host_keys_host_port_key" ON "ssh_host_keys"("host", "port");
