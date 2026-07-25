import subprocess, os, json, time, traceback
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
RESULTS=ROOT/'test-results'
RESULTS.mkdir(exist_ok=True)
STATE=RESULTS/'live-memory-sequential-initialization-state.json'
STATUS=RESULTS/'live-sequential-orchestrator-status.json'
DONE=RESULTS/'live-sequential-orchestrator.done'
LOCK=RESULTS/'live-sequential-orchestrator.lock'
TEST='test/live-memory-sequential-batch.integration.spec.ts'

def save(payload):
    payload={**payload,'updatedAt':time.strftime('%Y-%m-%dT%H:%M:%S')}
    STATUS.write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding='utf-8')

def state():
    try: return json.loads(STATE.read_text(encoding='utf-8'))
    except Exception: return {'nextBatchIndex':0,'batches':[]}

def test_process_active():
    try:
        raw=subprocess.check_output(['wmic','process','get','ProcessId,CommandLine','/format:csv'],text=True,errors='ignore',creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    except Exception: return False
    return any(TEST.lower() in line.lower() and 'wmic' not in line.lower() and 'run_sequential_initialization.py' not in line.lower() for line in raw.splitlines())

try:
    LOCK.write_text(str(os.getpid()),encoding='utf-8')
    # Let an already-running first batch finish; never overlap model calls.
    wait_started=time.time()
    while test_process_active() and time.time()-wait_started < 540:
        save({'status':'waiting-existing-batch','pid':os.getpid(),'state':state()})
        time.sleep(10)
    current=state().get('nextBatchIndex',0)
    env_base=os.environ.copy(); env_base['RUN_LIVE_MEMORY_MODEL']='1'
    pnpm=str(Path(env_base.get('APPDATA',''))/'npm'/'pnpm.cmd')
    for batch in range(int(current),10):
        latest=state()
        if int(latest.get('nextBatchIndex',0)) != batch:
            raise RuntimeError(f'checkpoint mismatch before batch {batch+1}: {latest.get("nextBatchIndex")}')
        save({'status':'running','pid':os.getpid(),'currentBatch':batch+1,'nextBatchIndex':batch,'completedBatches':len(latest.get('batches',[]))})
        env=env_base.copy(); env['LIVE_BATCH_INDEX']=str(batch)
        log=RESULTS/f'live-sequential-batch-{batch+1:02d}.log'
        with log.open('w',encoding='utf-8') as fh:
            completed=subprocess.run([pnpm,'vitest','run',TEST],cwd=ROOT,env=env,stdout=fh,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0),timeout=540)
        latest=state()
        if completed.returncode != 0 or int(latest.get('nextBatchIndex',0)) != batch+1:
            save({'status':'failed','pid':os.getpid(),'failedBatch':batch+1,'exitCode':completed.returncode,'state':latest,'log':str(log)})
            raise SystemExit(1)
        save({'status':'batch-completed','pid':os.getpid(),'completedBatch':batch+1,'nextBatchIndex':batch+1,'lastBatch':(latest.get('batches') or [None])[-1]})
    final=RESULTS/'live-memory-sequential-initialization-final.json'
    payload=json.loads(final.read_text(encoding='utf-8')) if final.exists() else None
    save({'status':'completed' if payload else 'failed','pid':os.getpid(),'nextBatchIndex':state().get('nextBatchIndex'),'summary':payload.get('summary') if payload else None,'queries':payload.get('queries') if payload else None,'finalReport':str(final)})
    if not payload: raise SystemExit(2)
    DONE.write_text('ok',encoding='utf-8')
except BaseException as error:
    if not isinstance(error,SystemExit):
        save({'status':'failed','pid':os.getpid(),'error':str(error),'traceback':traceback.format_exc(),'state':state()})
    raise
finally:
    try: LOCK.unlink()
    except Exception: pass
