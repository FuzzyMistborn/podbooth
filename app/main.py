from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from contextlib import asynccontextmanager
import os

from app.routers import sessions, upload, dashboard, login
from app.config import settings
from app import models


@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(settings.recordings_dir, exist_ok=True)
    models.load()
    yield


app = FastAPI(title="PodBooth", lifespan=lifespan)

app.mount("/static", StaticFiles(directory="app/static"), name="static")

app.include_router(login.router)
app.include_router(sessions.router)
app.include_router(upload.router)
app.include_router(dashboard.router)
