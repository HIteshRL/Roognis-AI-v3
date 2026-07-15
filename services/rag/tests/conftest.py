import os
import shutil
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("FILE_STORAGE_PATH", str(Path(tempfile.gettempdir()) / "roognis-rag-tests"))
os.environ.setdefault("RAG_DB_SCHEMA", "")
os.environ.setdefault("RAG_TEST_MODE", "true")

from main import app
from database import Base, engine


@pytest.fixture()
def client():
    storage_path = Path(os.environ["FILE_STORAGE_PATH"])
    if storage_path.exists():
        shutil.rmtree(storage_path)
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    with TestClient(app) as test_client:
        yield test_client


# Auth removed: there is no token to mint. school_id is now an ordinary request
# parameter, so tests pass it directly instead of encoding it into a JWT.
DEFAULT_TEST_SCHOOL_ID = "22222222-2222-2222-2222-222222222222"


@pytest.fixture()
def school_id():
    return DEFAULT_TEST_SCHOOL_ID
