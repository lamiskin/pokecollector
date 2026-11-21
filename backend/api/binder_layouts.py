"""Owner-scoped physical layout endpoints; public reads live on api.public."""
from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from api.auth import get_current_user
from database import get_db
from models import User
from schemas import BinderLayoutPreview, BinderLayoutUpdate, BinderLayoutUndo, BinderPlacementMove
from services import binder_layouts as layouts

router = APIRouter()


def _write(db, operation):
    try:
        return operation()
    except Exception:
        db.rollback()
        raise


@router.get("/{binder_id}/layout")
def get_binder_layout(binder_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db), response: Response = None):
    if response is not None:
        response.headers["Cache-Control"] = "no-store"
    return layouts.layout_state(db, layouts.owned_binder(db, current_user.id, binder_id))


@router.post("/{binder_id}/layout/preview")
def preview_binder_layout(binder_id: int, request: BinderLayoutPreview,
                          current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return layouts.preview_layout(db, layouts.owned_binder(db, current_user.id, binder_id), request)


@router.put("/{binder_id}/layout")
def update_binder_layout(binder_id: int, request: BinderLayoutUpdate,
                         current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _write(db, lambda: layouts.configure_layout(db, current_user.id, binder_id, request))


@router.post("/{binder_id}/placements")
def move_binder_copy(binder_id: int, request: BinderPlacementMove,
                      current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _write(db, lambda: layouts.move_copy(db, current_user.id, binder_id, request))


@router.post("/{binder_id}/layout/undo")
def undo_binder_layout(binder_id: int, request: BinderLayoutUndo,
                        current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _write(db, lambda: layouts.undo_layout(db, current_user.id, binder_id, request.expected_revision))
