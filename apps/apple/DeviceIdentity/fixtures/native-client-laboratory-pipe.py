# LAB ONLY finite detached stdout holder. No output, network or Keychain access.
import os, sys, time
if os.getpid() == os.getpgrp():
    if os.fork():
        os._exit(0)
os.setsid()
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, "w") as record:
    record.write(str(os.getpid()))
time.sleep(1.5)
