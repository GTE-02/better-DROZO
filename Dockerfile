FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update --fix-missing && apt-get install -y \
    openbox \
    chromium \
    novnc \
    websockify \
    tigervnc-standalone-server \
    dbus-x11 \
    fonts-liberation \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

RUN ln -s /usr/share/novnc/vnc.html /usr/share/novnc/index.html

RUN useradd -ms /bin/bash drozouser
USER drozouser
WORKDIR /home/drozouser

RUN mkdir -p ~/.vnc && echo '#!/bin/bash\n\
export DISPLAY=:1\n\
if command -v dbus-launch >/dev/null 2>&1; then\n\
  eval $(dbus-launch --sh-syntax)\n\
fi\n\
exec openbox-session' > ~/.vnc/xstartup && chmod +x ~/.vnc/xstartup

EXPOSE 6080
ENV JITSI_URL="https://meet.jit.si/drozo-sanctuary"

# 60 FPS low-latency server configuration
RUN echo '#!/bin/bash\n\
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1\n\
vncserver :1 -geometry 1920x1080 -depth 24 -SecurityTypes None -FrameRate=60\n\
websockify --web=/usr/share/novnc/ --heartbeat=30 6080 localhost:5901 &\n\
export DISPLAY=:1\n\
while [ ! -e /tmp/.X11-unix/X1 ]; do sleep 0.1; done\n\
sleep 0.5\n\
chromium --kiosk --no-sandbox \
  --window-size=1920,1080 \
  --disable-dev-shm-usage \
  --disable-gpu \
  --disable-software-rasterizer \
  --disable-smooth-scrolling \
  --no-zygote \
  --use-fake-ui-for-media-stream \
  --enable-font-antialiasing \
  "$JITSI_URL" &\n\
tail -f /dev/null' > ~/start.sh && chmod +x ~/start.sh

CMD ["/home/drozouser/start.sh"]
