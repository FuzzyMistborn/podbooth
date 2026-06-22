from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from contextlib import asynccontextmanager
import logging
import os

from app.routers import sessions, upload, dashboard, login, export, transcribe
from app.routers.upload import recover_orphaned_chunks
from app.config import settings
from app import models

logging.basicConfig(
    level=getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(settings.recordings_dir, exist_ok=True)
    models.load()
    await models.purge_expired()
    # Recover any chunks that were never finalized before the last shutdown
    # (e.g. a client crashed mid-recording). Assembly runs as background tasks.
    for session in models.list_sessions():
        await recover_orphaned_chunks(session)
    yield


app = FastAPI(title="PodBooth", lifespan=lifespan)

app.mount("/static", StaticFiles(directory="app/static"), name="static")

app.include_router(login.router)
app.include_router(sessions.router)
app.include_router(upload.router)
app.include_router(dashboard.router)
app.include_router(export.router)
app.include_router(transcribe.router)
