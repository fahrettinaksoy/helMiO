#!/usr/bin/env bash
# Seed a rich set of demo Supervisor programs into a test container so the panel
# has plenty to show: multiple groups, single services, a stopped one and a
# flapping one (to demo the restart counter + flapping badge).
#
# Usage: test/seed-demo.sh [container]   (default: helmio-test-debian)
set -e
CONTAINER="${1:-helmio-test-debian}"

docker exec "$CONTAINER" sh -c 'cat > /etc/supervisor/conf.d/demo.conf <<"EOF"
[program:demo-ticker]
command=/bin/sh -c "while true; do echo $(date +%%Y-%%m-%%dT%%H:%%M:%%S) tick; sleep 5; done"
autostart=true
autorestart=true
stdout_logfile=/var/log/demo-ticker.log
stderr_logfile=/var/log/demo-ticker.err

[program:demo-worker]
command=/bin/sh -c "while true; do echo $(date +%%Y-%%m-%%dT%%H:%%M:%%S) working; sleep 10; done"
autostart=true
autorestart=true
numprocs=3
process_name=%(program_name)s_%(process_num)02d
stdout_logfile=/var/log/demo-worker-%(process_num)02d.log
stderr_logfile=/var/log/demo-worker-%(process_num)02d.err

[program:demo-api]
command=/bin/sh -c "while true; do echo $(date +%%Y-%%m-%%dT%%H:%%M:%%S) serving request; sleep 2; done"
autostart=true
autorestart=true
numprocs=2
process_name=%(program_name)s_%(process_num)02d
stdout_logfile=/var/log/demo-api-%(process_num)02d.log
stderr_logfile=/var/log/demo-api-%(process_num)02d.err

[program:demo-db]
command=/bin/sh -c "while true; do sleep 30; done"
autostart=true
autorestart=true
stdout_logfile=/var/log/demo-db.log
stderr_logfile=/var/log/demo-db.err

[program:demo-cache]
command=/bin/sh -c "while true; do sleep 20; done"
autostart=true
autorestart=true
stdout_logfile=/var/log/demo-cache.log
stderr_logfile=/var/log/demo-cache.err

[program:demo-batch]
command=/bin/sh -c "echo batch done; sleep 1"
autostart=false
autorestart=false
stdout_logfile=/var/log/demo-batch.log
stderr_logfile=/var/log/demo-batch.err

[program:demo-flaky]
command=/bin/sh -c "echo starting; sleep 3; exit 1"
autostart=true
autorestart=true
startsecs=10
startretries=100
stdout_logfile=/var/log/demo-flaky.log
stderr_logfile=/var/log/demo-flaky.err
EOF
supervisorctl reread && supervisorctl update' || true

echo "Seeded demo programs into $CONTAINER."
docker exec "$CONTAINER" supervisorctl status || true
