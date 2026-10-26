#!/usr/bin/env python3
"""Observe launcher argv and side effects with an executable Node spy, not a host."""
import json,os,pathlib,shutil,stat,subprocess,tempfile
repo=pathlib.Path(__file__).resolve().parents[3]
with tempfile.TemporaryDirectory(prefix="dexter-runtime-check-") as raw:
 root=pathlib.Path(raw).resolve();root.chmod(0o700)
 fixture=root/"repo with spaces"; scripts=fixture/"ops/local-host/scripts"
 scripts.mkdir(parents=True);(fixture/"packages/cli/dist").mkdir(parents=True)
 for name in ["preflight.sh","launch.sh"]:
  p=scripts/name;shutil.copyfile(repo/"ops/local-host/scripts"/name,p);p.chmod(0o700)
 for name in ["package.json","pnpm-lock.yaml","packages/cli/dist/index.js"]:(fixture/name).write_text("")
 bindir=root/"bin";bindir.mkdir()
 node=r"""#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == -p ]]; then printf '24.20.0\n'; exit 0; fi
if [[ "${1:-}" == -e ]]; then exit 0; fi
if [[ "${2:-}" == --help ]]; then printf 'dexter serve --enable-engines --enable-mcp\n'; exit 0; fi
if [[ "${2:-}" == serve ]]; then printf '%s\0' "$@" >"$DEXTER_LAUNCH_ARGS"; exit 0; fi
exit 91
"""
 (bindir/"node").write_text(node)
 (bindir/"pnpm").write_text('#!/usr/bin/env bash\nprintf unexpected >"$DEXTER_PNPM_MARKER"\nexit 92\n')
 for name in ["node","pnpm"]:(bindir/name).chmod(0o700)
 args=root/"args";marker=root/"pnpm-called"
 env={"PATH":str(bindir)+os.pathsep+os.environ.get("PATH","/usr/bin:/bin"),"DEXTER_LAUNCH_ARGS":str(args),"DEXTER_PNPM_MARKER":str(marker),"TMPDIR":str(root)}
 records=[]
 for choice,flags in [("default",[]),("engines",["--enable-engines"]),("mcp",["--enable-engines","--enable-mcp"])]:
  data=root/choice
  r=subprocess.run(["/bin/bash",str(scripts/"launch.sh"),"--start","--data-dir",str(data),*flags],env=env,capture_output=True,timeout=15)
  assert r.returncode==0,"spy start refused"
  actual=[v.decode() for v in args.read_bytes().split(b'\0')[:-1]]
  assert actual==[str(fixture/"packages/cli/dist/index.js"),"serve","--data-dir",str(data),"--port","4317",*flags]
  assert stat.S_IMODE(data.stat().st_mode)==0o700
  records.append({"case":choice,"passed":True})
 args.unlink()
 r=subprocess.run(["/bin/bash",str(scripts/"launch.sh"),"--start","--data-dir",str(root/"refused"),"--enable-mcp"],env=env,capture_output=True,timeout=15)
 assert r.returncode==2 and not (root/"refused").exists() and not args.exists()
 records.append({"case":"mcp_without_engine_refused_before_create","passed":True})
 r=subprocess.run(["/bin/bash",str(scripts/"launch.sh"),"--check","--data-dir",str(root/"missing")],env=env,capture_output=True,timeout=15)
 assert r.returncode==0 and not (root/"missing").exists() and not args.exists()
 records.append({"case":"check_without_create_or_start","passed":True})
 assert not marker.exists()
 records.append({"case":"package_manager_never_invoked","passed":True})
 print(json.dumps({"scope":"Node argv spy; no host/inference/install/service","checks":records,"passed":len(records)}))
