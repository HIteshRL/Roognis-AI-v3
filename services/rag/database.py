from collections.abc import Generator

from sqlalchemy import MetaData, create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.schema import CreateSchema
from sqlalchemy.pool import StaticPool

from config import get_settings


settings = get_settings()
metadata = MetaData(schema=settings.rag_db_schema or None)


class Base(DeclarativeBase):
    metadata = metadata


engine_options = {
    "future": True,
    "pool_pre_ping": True,
}

if settings.sqlalchemy_database_url.startswith("sqlite"):
    engine_options.update(
        {
            "connect_args": {"check_same_thread": False},
            "poolclass": StaticPool,
        }
    )

engine = create_engine(settings.sqlalchemy_database_url, **engine_options)

SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    autocommit=False,
    expire_on_commit=False,
    future=True,
)


def init_db() -> None:
    if settings.rag_db_schema and engine.dialect.name == "postgresql":
        with engine.begin() as connection:
            connection.execute(CreateSchema(settings.rag_db_schema, if_not_exists=True))

    Base.metadata.create_all(bind=engine)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
