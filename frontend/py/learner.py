"""
scikit-learner — Pyodide port of the FastAPI backend.

Runs inside the user's browser via Pyodide. Every former HTTP endpoint is a
plain Python function: takes JSON-ish args, returns JSON-serializable dicts
(or raw bytes for downloads). Errors raise ValueError which the JS bridge
converts to UI error messages.

State lives in the module-level `current_data` dict, scoped to the page
(each tab gets its own Pyodide instance, so multi-user concerns are moot).
"""

from __future__ import annotations

import inspect
import io
import re
import json
import zipfile
from datetime import datetime
from typing import Any

import joblib
import numpy as np
import pandas as pd

from sklearn.datasets import (
    load_breast_cancer,
    load_diabetes,
    load_digits,
    load_iris,
    load_wine,
    make_regression,
)
from sklearn.ensemble import (
    AdaBoostClassifier,
    AdaBoostRegressor,
    ExtraTreesClassifier,
    ExtraTreesRegressor,
    GradientBoostingClassifier,
    GradientBoostingRegressor,
    RandomForestClassifier,
    RandomForestRegressor,
)
from sklearn.linear_model import (
    BayesianRidge,
    ElasticNet,
    HuberRegressor,
    Lasso,
    LinearRegression,
    LogisticRegression,
    Ridge,
)
from sklearn.metrics import (
    accuracy_score,
    auc,
    confusion_matrix,
    f1_score,
    mean_absolute_error,
    mean_squared_error,
    precision_score,
    r2_score,
    recall_score,
    roc_curve,
)
from sklearn.model_selection import cross_val_predict, cross_val_score
from sklearn.pipeline import make_pipeline
from sklearn.neighbors import KNeighborsClassifier, KNeighborsRegressor
from sklearn.neural_network import MLPClassifier, MLPRegressor
from sklearn.preprocessing import StandardScaler, label_binarize
from sklearn.svm import SVC, SVR
from sklearn.tree import DecisionTreeClassifier, DecisionTreeRegressor

# Module-level state — replaces backend's global current_data dict.
current_data: dict[str, Any] = {
    "df": None,
    "filename": None,
    "columns": [],
    "numeric_columns": [],
    "target": None,
    "features": [],
    "models": {},
    "model_counter": 0,
    "task_type": "regression",
}

AVAILABLE_MODELS = {
    "linear_regression": {"name": "Linear Regression", "class": LinearRegression, "params": {}, "category": "Linear"},
    "ridge": {"name": "Ridge Regression", "class": Ridge, "params": {"alpha": 1.0}, "category": "Linear"},
    "ridge_strong": {"name": "Ridge (Strong Regularization)", "class": Ridge, "params": {"alpha": 10.0}, "category": "Linear"},
    "lasso": {"name": "Lasso Regression", "class": Lasso, "params": {"alpha": 1.0}, "category": "Linear"},
    "elastic_net": {"name": "Elastic Net", "class": ElasticNet, "params": {"alpha": 1.0, "l1_ratio": 0.5}, "category": "Linear"},
    "bayesian_ridge": {"name": "Bayesian Ridge", "class": BayesianRidge, "params": {}, "category": "Linear"},
    "huber": {"name": "Huber Regressor", "class": HuberRegressor, "params": {"epsilon": 1.35}, "category": "Linear"},
    "decision_tree": {"name": "Decision Tree", "class": DecisionTreeRegressor, "params": {"max_depth": None, "random_state": 42}, "category": "Tree"},
    "decision_tree_fine": {"name": "Fine Tree", "class": DecisionTreeRegressor, "params": {"max_depth": 100, "min_samples_leaf": 1, "random_state": 42}, "category": "Tree"},
    "decision_tree_medium": {"name": "Medium Tree", "class": DecisionTreeRegressor, "params": {"max_depth": 20, "min_samples_leaf": 4, "random_state": 42}, "category": "Tree"},
    "decision_tree_coarse": {"name": "Coarse Tree", "class": DecisionTreeRegressor, "params": {"max_depth": 4, "min_samples_leaf": 12, "random_state": 42}, "category": "Tree"},
    "random_forest": {"name": "Random Forest", "class": RandomForestRegressor, "params": {"n_estimators": 100, "random_state": 42}, "category": "Ensemble"},
    "random_forest_fine": {"name": "Fine Random Forest", "class": RandomForestRegressor, "params": {"n_estimators": 200, "max_depth": None, "min_samples_leaf": 1, "random_state": 42}, "category": "Ensemble"},
    "gradient_boosting": {"name": "Gradient Boosting", "class": GradientBoostingRegressor, "params": {"n_estimators": 100, "random_state": 42}, "category": "Ensemble"},
    "adaboost": {"name": "AdaBoost", "class": AdaBoostRegressor, "params": {"n_estimators": 50, "random_state": 42}, "category": "Ensemble"},
    "extra_trees": {"name": "Extra Trees", "class": ExtraTreesRegressor, "params": {"n_estimators": 100, "random_state": 42}, "category": "Ensemble"},
    "svr_linear": {"name": "Linear SVR", "class": SVR, "params": {"kernel": "linear", "C": 1.0}, "category": "SVM"},
    "svr_rbf": {"name": "RBF SVR", "class": SVR, "params": {"kernel": "rbf", "C": 1.0, "gamma": "scale"}, "category": "SVM"},
    "svr_poly": {"name": "Polynomial SVR", "class": SVR, "params": {"kernel": "poly", "degree": 3, "C": 1.0}, "category": "SVM"},
    "knn": {"name": "K-Nearest Neighbors", "class": KNeighborsRegressor, "params": {"n_neighbors": 5}, "category": "Neighbors"},
    "knn_fine": {"name": "Fine KNN", "class": KNeighborsRegressor, "params": {"n_neighbors": 1}, "category": "Neighbors"},
    "knn_medium": {"name": "Medium KNN", "class": KNeighborsRegressor, "params": {"n_neighbors": 10}, "category": "Neighbors"},
    "knn_coarse": {"name": "Coarse KNN", "class": KNeighborsRegressor, "params": {"n_neighbors": 100}, "category": "Neighbors"},
    "mlp": {"name": "Neural Network", "class": MLPRegressor, "params": {"hidden_layer_sizes": (100,), "max_iter": 500, "random_state": 42}, "category": "Neural Network"},
    "mlp_wide": {"name": "Wide Neural Network", "class": MLPRegressor, "params": {"hidden_layer_sizes": (200,), "max_iter": 500, "random_state": 42}, "category": "Neural Network"},
    "mlp_deep": {"name": "Deep Neural Network", "class": MLPRegressor, "params": {"hidden_layer_sizes": (100, 50, 25), "max_iter": 500, "random_state": 42}, "category": "Neural Network"},
}

# AdaBoostClassifier's `algorithm` parameter was deprecated in scikit-learn
# 1.4 and removed in 1.6, where SAMME is the only algorithm there is. Passing
# it to a modern sklearn raises TypeError before a single tree is fitted;
# omitting it on an older one silently selects the deprecated SAMME.R, which
# is a different model. Neither is acceptable, and neither can be decided at
# authoring time: this module runs against Pyodide's sklearn in the browser,
# whatever a notebook kernel has, and whatever a VS Code user's venv has.
#
# So ask the class rather than a version string — the signature is the thing
# that actually decides whether the call succeeds. Resolved once at import,
# so the catalogue, the tooltip and the generated pipeline.py all agree with
# what was really fitted.
_ADABOOST_ALGORITHM = (
    {"algorithm": "SAMME"}
    if "algorithm" in inspect.signature(AdaBoostClassifier).parameters
    else {}
)

AVAILABLE_CLASSIFICATION_MODELS = {
    "logistic_regression": {"name": "Logistic Regression", "class": LogisticRegression, "params": {"max_iter": 1000, "random_state": 42}, "category": "Linear"},
    "logistic_l1": {"name": "Logistic Regression (L1)", "class": LogisticRegression, "params": {"penalty": "l1", "solver": "saga", "max_iter": 1000, "random_state": 42}, "category": "Linear"},
    "logistic_l2": {"name": "Logistic Regression (L2)", "class": LogisticRegression, "params": {"penalty": "l2", "max_iter": 1000, "random_state": 42}, "category": "Linear"},
    "decision_tree_clf": {"name": "Decision Tree", "class": DecisionTreeClassifier, "params": {"max_depth": None, "random_state": 42}, "category": "Tree"},
    "decision_tree_clf_fine": {"name": "Fine Tree", "class": DecisionTreeClassifier, "params": {"max_depth": 100, "min_samples_leaf": 1, "random_state": 42}, "category": "Tree"},
    "decision_tree_clf_medium": {"name": "Medium Tree", "class": DecisionTreeClassifier, "params": {"max_depth": 20, "min_samples_leaf": 4, "random_state": 42}, "category": "Tree"},
    "decision_tree_clf_coarse": {"name": "Coarse Tree", "class": DecisionTreeClassifier, "params": {"max_depth": 4, "min_samples_leaf": 12, "random_state": 42}, "category": "Tree"},
    "random_forest_clf": {"name": "Random Forest", "class": RandomForestClassifier, "params": {"n_estimators": 100, "random_state": 42}, "category": "Ensemble"},
    "random_forest_clf_fine": {"name": "Fine Random Forest", "class": RandomForestClassifier, "params": {"n_estimators": 200, "max_depth": None, "min_samples_leaf": 1, "random_state": 42}, "category": "Ensemble"},
    "gradient_boosting_clf": {"name": "Gradient Boosting", "class": GradientBoostingClassifier, "params": {"n_estimators": 100, "random_state": 42}, "category": "Ensemble"},
    "adaboost_clf": {"name": "AdaBoost", "class": AdaBoostClassifier, "params": {"n_estimators": 50, "random_state": 42, **_ADABOOST_ALGORITHM}, "category": "Ensemble"},
    "extra_trees_clf": {"name": "Extra Trees", "class": ExtraTreesClassifier, "params": {"n_estimators": 100, "random_state": 42}, "category": "Ensemble"},
    "svc_linear": {"name": "Linear SVC", "class": SVC, "params": {"kernel": "linear", "C": 1.0, "probability": True, "random_state": 42}, "category": "SVM"},
    "svc_rbf": {"name": "RBF SVC", "class": SVC, "params": {"kernel": "rbf", "C": 1.0, "gamma": "scale", "probability": True, "random_state": 42}, "category": "SVM"},
    "svc_poly": {"name": "Polynomial SVC", "class": SVC, "params": {"kernel": "poly", "degree": 3, "C": 1.0, "probability": True, "random_state": 42}, "category": "SVM"},
    "knn_clf": {"name": "K-Nearest Neighbors", "class": KNeighborsClassifier, "params": {"n_neighbors": 5}, "category": "Neighbors"},
    "knn_clf_fine": {"name": "Fine KNN", "class": KNeighborsClassifier, "params": {"n_neighbors": 1}, "category": "Neighbors"},
    "knn_clf_medium": {"name": "Medium KNN", "class": KNeighborsClassifier, "params": {"n_neighbors": 10}, "category": "Neighbors"},
    "knn_clf_coarse": {"name": "Coarse KNN", "class": KNeighborsClassifier, "params": {"n_neighbors": 100}, "category": "Neighbors"},
    "mlp_clf": {"name": "Neural Network", "class": MLPClassifier, "params": {"hidden_layer_sizes": (100,), "max_iter": 500, "random_state": 42}, "category": "Neural Network"},
    "mlp_clf_wide": {"name": "Wide Neural Network", "class": MLPClassifier, "params": {"hidden_layer_sizes": (200,), "max_iter": 500, "random_state": 42}, "category": "Neural Network"},
    "mlp_clf_deep": {"name": "Deep Neural Network", "class": MLPClassifier, "params": {"hidden_layer_sizes": (100, 50, 25), "max_iter": 500, "random_state": 42}, "category": "Neural Network"},
}


def available_models(task_type: str = "regression") -> dict:
    """Return models grouped by category for a given task type."""
    src = AVAILABLE_CLASSIFICATION_MODELS if task_type == "classification" else AVAILABLE_MODELS
    by_category: dict[str, list] = {}
    for key, info in src.items():
        by_category.setdefault(info["category"], []).append(
            {
                "key": key,
                "name": info["name"],
                "params": _serializable_params(info["params"]),
                # For consumers that generate equivalent sklearn code (the VS
                # Code extension's pipeline.py). Public module path, not the
                # private submodule the class is defined in.
                "class_name": info["class"].__name__,
                "module": info["class"].__module__.split("._")[0],
            }
        )
    return {"models": by_category, "task_type": task_type}


def _serializable_params(params: dict) -> dict:
    """Tuple → list so JS can read it."""
    return {k: (list(v) if isinstance(v, tuple) else v) for k, v in params.items()}


def list_samples() -> dict:
    """Sample datasets the UI offers (parity with /api/data/sample)."""
    return {
        "datasets": [
            {"name": "Airfoil Self-Noise", "key": "airfoil"},
            {"name": "Boston Housing (Synthetic)", "key": "boston"},
            {"name": "Diabetes", "key": "diabetes"},
            {"name": "Synthetic Regression", "key": "synthetic"},
        ]
    }


def _ingest_df(df: pd.DataFrame, filename: str, task_type: str) -> dict:
    """Common state mutation when a fresh dataframe is loaded."""
    current_data["df"] = df
    current_data["filename"] = filename
    current_data["columns"] = df.columns.tolist()
    current_data["numeric_columns"] = df.select_dtypes(include=[np.number]).columns.tolist()
    current_data["models"] = {}
    current_data["model_counter"] = 0
    current_data["task_type"] = task_type
    return {
        "success": True,
        "filename": filename,
        "columns": current_data["columns"],
        "numeric_columns": current_data["numeric_columns"],
        "task_type": task_type,
        "stats": {
            "rows": len(df),
            "columns": len(df.columns),
            "numeric_columns": len(current_data["numeric_columns"]),
            "missing_values": int(df.isnull().sum().sum()),
        },
        "preview": df.head(10).to_dict(orient="records"),
    }


def upload_csv(buffer, filename: str) -> dict:
    """Accept raw bytes (or Pyodide JsProxy of Uint8Array) and load as CSV."""
    if hasattr(buffer, "to_py"):
        buffer = bytes(buffer.to_py())
    elif isinstance(buffer, memoryview):
        buffer = bytes(buffer)
    elif not isinstance(buffer, (bytes, bytearray)):
        buffer = bytes(buffer)
    if not filename.lower().endswith(".csv"):
        raise ValueError("Only CSV files are supported")
    try:
        df = pd.read_csv(io.BytesIO(buffer))
    except Exception as exc:
        raise ValueError(f"Failed to parse CSV: {exc}") from exc
    return _ingest_df(df, filename, "regression")


def data_info() -> dict:
    if current_data["df"] is None:
        raise ValueError("No data loaded")
    df = current_data["df"]
    return {
        "filename": current_data["filename"],
        "rows": len(df),
        "columns": current_data["columns"],
        "numeric_columns": current_data["numeric_columns"],
        "stats": df.describe().to_dict(),
    }


def data_preview() -> dict:
    if current_data["df"] is None:
        raise ValueError("No data loaded")
    df = current_data["df"]
    sample_df = df.head(1000) if len(df) > 1000 else df
    numeric_cols = current_data["numeric_columns"]
    data = {col: sample_df[col].tolist() for col in numeric_cols}
    return {
        "columns": numeric_cols,
        "data": data,
        "total_rows": len(df),
        "sampled_rows": len(sample_df),
    }


def load_sample(dataset_key: str) -> dict:
    """Built-in sklearn datasets + a bundled CSV for airfoil + synthetic Boston."""
    task_type = "regression"
    if dataset_key == "airfoil":
        # Bundled CSV — original backend used fetch_openml which won't work in Pyodide.
        try:
            df = pd.read_csv("/data/airfoil.csv")
        except FileNotFoundError as exc:
            raise ValueError("Airfoil dataset CSV not bundled — see /data/airfoil.csv") from exc
    elif dataset_key == "diabetes":
        data = load_diabetes()
        df = pd.DataFrame(data.data, columns=data.feature_names)
        df["target"] = data.target
    elif dataset_key == "synthetic":
        X, y = make_regression(n_samples=500, n_features=5, noise=10, random_state=42)
        df = pd.DataFrame(X, columns=[f"feature_{i}" for i in range(5)])
        df["target"] = y
    elif dataset_key == "boston":
        rng = np.random.default_rng(42)
        n = 506
        df = pd.DataFrame({
            "CRIM": rng.exponential(3, n),
            "ZN": rng.choice([0, 12.5, 25, 100], n),
            "INDUS": rng.uniform(0, 28, n),
            "CHAS": rng.choice([0, 1], n, p=[0.93, 0.07]),
            "NOX": rng.uniform(0.3, 0.9, n),
            "RM": rng.normal(6.3, 0.7, n),
            "AGE": rng.uniform(0, 100, n),
            "DIS": rng.exponential(3, n) + 1,
            "RAD": rng.choice(range(1, 25), n),
            "TAX": rng.uniform(180, 720, n),
            "PTRATIO": rng.uniform(12, 22, n),
            "LSTAT": rng.uniform(1, 38, n),
        })
        df["target"] = (
            -0.1 * df["CRIM"] + 0.05 * df["ZN"] + 4 * df["RM"]
            - 0.5 * df["DIS"] - 0.01 * df["TAX"] - 0.5 * df["PTRATIO"]
            - 0.6 * df["LSTAT"] + rng.normal(0, 3, n) + 20
        ).clip(5, 50)
    elif dataset_key == "iris":
        data = load_iris()
        df = pd.DataFrame(data.data, columns=data.feature_names)
        df["target"] = data.target
        task_type = "classification"
    elif dataset_key == "wine":
        data = load_wine()
        df = pd.DataFrame(data.data, columns=data.feature_names)
        df["target"] = data.target
        task_type = "classification"
    elif dataset_key == "breast_cancer":
        data = load_breast_cancer()
        df = pd.DataFrame(data.data, columns=data.feature_names)
        df["target"] = data.target
        task_type = "classification"
    elif dataset_key == "digits":
        data = load_digits()
        df = pd.DataFrame(data.data, columns=[f"pixel_{i}" for i in range(64)])
        df["target"] = data.target
        task_type = "classification"
    else:
        raise ValueError(f"Unknown dataset: {dataset_key}")

    return _ingest_df(df, f"{dataset_key}_dataset.csv", task_type)


def train(
    model_type: str,
    features: list,
    target: str,
    cv_folds: int = 5,
    task_type: str = "regression",
) -> dict:
    """Train a single model. Mirrors POST /api/model/train."""
    if hasattr(features, "to_py"):
        features = list(features.to_py())
    elif not isinstance(features, list):
        features = list(features)

    if current_data["df"] is None:
        raise ValueError("No data loaded")

    is_classification = task_type == "classification"
    models_dict = AVAILABLE_CLASSIFICATION_MODELS if is_classification else AVAILABLE_MODELS
    if model_type not in models_dict:
        raise ValueError(f"Unknown model type: {model_type}")

    df = current_data["df"]
    for f in features:
        if f not in df.columns:
            raise ValueError(f"Feature not found: {f}")
    if target not in df.columns:
        raise ValueError(f"Target not found: {target}")

    X = df[features].values
    y = df[target].values
    mask = ~(np.isnan(X).any(axis=1) | (np.isnan(y) if y.dtype.kind == "f" else False))
    n_dropped = int(len(X) - int(mask.sum()))
    X = X[mask]
    y = y[mask]

    # The full fit, on everything. In-sample metrics and the exported artifact
    # both come from here, and a scaler fitted on all the data is correct for
    # a model that was also fitted on all the data.
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    info = models_dict[model_type]
    model = info["class"](**info["params"])

    # Cross-validation gets its own estimator, and it must be a Pipeline.
    #
    # Scaling X once up front and then handing the scaled matrix to
    # cross_val_score is the classic preprocessing leak: the scaler has already
    # seen every fold's held-out rows, so their own mean and variance went into
    # the transform that scales them, and every reported score comes out
    # optimistic. Inside a Pipeline the scaler is refitted on each training
    # fold, which is the only arrangement that makes the number mean what the
    # UI says it means. Passed the RAW X for the same reason.
    def _cv_estimator():
        return make_pipeline(StandardScaler(), info["class"](**info["params"]))

    current_data["model_counter"] += 1
    model_id = f"model_{current_data['model_counter']}"

    if is_classification:
        cv_scores = cross_val_score(_cv_estimator(), X, y, cv=cv_folds, scoring="accuracy")
        cv_predictions = cross_val_predict(_cv_estimator(), X, y, cv=cv_folds)
        model.fit(X_scaled, y)
        predictions = model.predict(X_scaled)

        classes = np.unique(y)
        n_classes = len(classes)
        accuracy = accuracy_score(y, predictions)
        avg = "binary" if n_classes == 2 else "weighted"
        f1 = f1_score(y, predictions, average=avg, zero_division=0)
        precision = precision_score(y, predictions, average=avg, zero_division=0)
        recall = recall_score(y, predictions, average=avg, zero_division=0)
        cm = confusion_matrix(y, predictions)

        roc_data = None
        if hasattr(model, "predict_proba"):
            try:
                y_proba = model.predict_proba(X_scaled)
                if n_classes == 2:
                    fpr, tpr, _ = roc_curve(y, y_proba[:, 1])
                    roc_data = {"fpr": fpr.tolist(), "tpr": tpr.tolist(), "auc": float(auc(fpr, tpr))}
                else:
                    y_bin = label_binarize(y, classes=classes)
                    fpr_list, tpr_list, auc_list = [], [], []
                    for i in range(n_classes):
                        fpr_i, tpr_i, _ = roc_curve(y_bin[:, i], y_proba[:, i])
                        fpr_list.append(fpr_i.tolist())
                        tpr_list.append(tpr_i.tolist())
                        auc_list.append(float(auc(fpr_i, tpr_i)))
                    roc_data = {"fpr": fpr_list, "tpr": tpr_list, "auc": auc_list}
            except Exception:
                pass

        current_data["models"][model_id] = {
            "model": model, "scaler": scaler,
            "type": model_type, "task_type": "classification",
            "name": info["name"], "category": info["category"],
            "features": features, "target": target,
            "metrics": {
                "accuracy": float(accuracy), "f1": float(f1),
                "precision": float(precision), "recall": float(recall),
                "cv_accuracy_mean": float(cv_scores.mean()),
                "cv_accuracy_std": float(cv_scores.std()),
            },
            "predictions": predictions.tolist(),
            "cv_predictions": cv_predictions.tolist(),
            "actual": y.tolist(),
            "confusion_matrix": cm.tolist(),
            "roc_curve": roc_data,
            "class_labels": classes.tolist(),
            "trained_at": datetime.now().isoformat(),
        }
        return {
            "success": True,
            "model_id": model_id,
            "model_name": info["name"],
            "category": info["category"],
            "task_type": "classification",
            "metrics": {
                "accuracy": round(float(accuracy), 4),
                "f1": round(float(f1), 4),
                "precision": round(float(precision), 4),
                "recall": round(float(recall), 4),
                "cv_accuracy_mean": round(float(cv_scores.mean()), 4),
                "cv_accuracy_std": round(float(cv_scores.std()), 4),
            },
            "confusion_matrix": cm.tolist(),
            "roc_curve": roc_data,
            "class_labels": classes.tolist(),
            "n_samples": int(len(y)),
            "n_features": len(features),
            "n_classes": int(n_classes),
            # Rows lost to the NaN mask above. Reported so a score can never
            # silently describe a smaller dataset than the panel shows.
            "n_dropped": n_dropped,
        }

    # regression
    cv_scores_r2 = cross_val_score(_cv_estimator(), X, y, cv=cv_folds, scoring="r2")
    cv_scores_mse = -cross_val_score(
        _cv_estimator(), X, y, cv=cv_folds, scoring="neg_mean_squared_error"
    )
    cv_predictions = cross_val_predict(_cv_estimator(), X, y, cv=cv_folds)
    model.fit(X_scaled, y)
    predictions = model.predict(X_scaled)

    r2 = r2_score(y, predictions)
    mse = mean_squared_error(y, predictions)
    rmse = float(np.sqrt(mse))
    mae = mean_absolute_error(y, predictions)
    cv_r2_mean = float(cv_scores_r2.mean())
    cv_r2_std = float(cv_scores_r2.std())
    cv_rmse_mean = float(np.sqrt(cv_scores_mse.mean()))

    current_data["models"][model_id] = {
        "model": model, "scaler": scaler,
        "type": model_type, "task_type": "regression",
        "name": info["name"], "category": info["category"],
        "features": features, "target": target,
        "metrics": {
            "r2": float(r2), "mse": float(mse), "rmse": rmse, "mae": float(mae),
            "cv_r2_mean": cv_r2_mean, "cv_r2_std": cv_r2_std,
            "cv_rmse_mean": cv_rmse_mean,
        },
        "predictions": predictions.tolist(),
        "cv_predictions": cv_predictions.tolist(),
        "actual": y.tolist(),
        "residuals": (y - predictions).tolist(),
        "trained_at": datetime.now().isoformat(),
    }
    return {
        "success": True,
        "model_id": model_id,
        "model_name": info["name"],
        "category": info["category"],
        "task_type": "regression",
        "metrics": {
            "r2": round(float(r2), 4),
            "mse": round(float(mse), 4),
            "rmse": round(rmse, 4),
            "mae": round(float(mae), 4),
            "cv_r2_mean": round(cv_r2_mean, 4),
            "cv_r2_std": round(cv_r2_std, 4),
            "cv_rmse_mean": round(cv_rmse_mean, 4),
        },
        "n_samples": int(len(y)),
        "n_features": len(features),
        "n_dropped": n_dropped,
    }


def get_model(model_id: str) -> dict:
    if model_id not in current_data["models"]:
        raise ValueError("Model not found")
    m = current_data["models"][model_id]
    return {
        "model_id": model_id,
        "name": m["name"], "type": m["type"], "category": m["category"],
        "features": m["features"], "target": m["target"],
        "metrics": m["metrics"], "trained_at": m["trained_at"],
    }


def predictions(model_id: str) -> dict:
    if model_id not in current_data["models"]:
        raise ValueError("Model not found")
    m = current_data["models"][model_id]
    out = {
        "model_id": model_id,
        "predictions": m["predictions"],
        "cv_predictions": m["cv_predictions"],
        "actual": m["actual"],
    }
    if "residuals" in m:
        out["residuals"] = m["residuals"]
    if "confusion_matrix" in m:
        out["confusion_matrix"] = m["confusion_matrix"]
    if "roc_curve" in m:
        out["roc_curve"] = m["roc_curve"]
    if "class_labels" in m:
        out["class_labels"] = m["class_labels"]
    return out


def scatter_data(model_id: str, x_feature: str | None = None, y_feature: str | None = None) -> dict:
    if model_id not in current_data["models"]:
        raise ValueError("Model not found")
    if current_data["df"] is None:
        raise ValueError("No data loaded")
    m = current_data["models"][model_id]
    df = current_data["df"]
    feats = m["features"]
    x_col = x_feature if x_feature in feats else feats[0]
    y_col = y_feature if y_feature in feats else (feats[1] if len(feats) > 1 else feats[0])
    return {
        "x": df[x_col].tolist(),
        "y": df[y_col].tolist(),
        "predictions": m["predictions"],
        "actual": m["actual"],
        "x_label": x_col, "y_label": y_col,
        "target": m["target"],
    }


def trained_models() -> dict:
    out = []
    for mid, m in current_data["models"].items():
        out.append({
            "model_id": mid, "name": m["name"], "type": m["type"],
            "category": m["category"], "metrics": m["metrics"],
            "features": m["features"], "target": m["target"],
            "trained_at": m["trained_at"],
        })
    return {"models": out}


def delete_model(model_id: str) -> dict:
    if model_id not in current_data["models"]:
        raise ValueError("Model not found")
    del current_data["models"][model_id]
    return {"success": True, "message": f"Model {model_id} deleted"}


def export_model(model_id: str) -> bytes:
    """Return joblib-serialized model bytes. JS wraps in a Blob for download."""
    if model_id not in current_data["models"]:
        raise ValueError("Model not found")
    m = current_data["models"][model_id]
    buf = io.BytesIO()
    joblib.dump({
        "model": m["model"], "scaler": m["scaler"],
        "features": m["features"], "target": m["target"],
        "metrics": m["metrics"],
        "task_type": m.get("task_type", "regression"),
    }, buf)
    return buf.getvalue()


def bulk_zip(model_ids: list) -> bytes:
    """Multiple models → zip of joblib files."""
    if hasattr(model_ids, "to_py"):
        model_ids = list(model_ids.to_py())
    if not model_ids:
        raise ValueError("No model IDs provided")
    for mid in model_ids:
        if mid not in current_data["models"]:
            raise ValueError(f"Model not found: {mid}")

    if len(model_ids) == 1:
        return export_model(model_ids[0])

    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for mid in model_ids:
            m = current_data["models"][mid]
            buf = io.BytesIO()
            joblib.dump({
                "model": m["model"], "scaler": m["scaler"],
                "features": m["features"], "target": m["target"],
                "metrics": m["metrics"],
                "task_type": m.get("task_type", "regression"),
            }, buf)
            zf.writestr(f"{m['type']}.joblib", buf.getvalue())
    return out.getvalue()


def comparison() -> dict:
    """Comparison table for trained regression models (matches /api/comparison)."""
    if not current_data["models"]:
        raise ValueError("No models trained")
    rows = []
    for mid, m in current_data["models"].items():
        if m.get("task_type") != "regression":
            continue
        metrics = m["metrics"]
        rows.append({
            "model_id": mid, "name": m["name"], "category": m["category"],
            "r2": metrics["r2"], "rmse": metrics["rmse"], "mae": metrics["mae"],
            "cv_r2": metrics["cv_r2_mean"],
        })
    rows.sort(key=lambda r: r["cv_r2"], reverse=True)
    return {"comparison": rows}


# ══════════════════════════════════════════════════════════════════════
#  Methodology gates
#
#  Deterministic checks over the loaded frame and the chosen configuration.
#  No model, no network, no heuristic beyond arithmetic — every finding here
#  is reproducible and explainable, which is the whole point: a generic
#  assistant guesses at these, and guessing is what produces a 0.99 that
#  evaporates in production.
#
#  Three severities, and they behave differently:
#    leak    something that makes a reported number wrong. Loud.
#    decide  a modelling choice the app currently makes silently on the
#            user's behalf. Offers options; the UI may block on it.
#    note    a fit worth knowing about. Annotates, never blocks.
#
#  Inline rather than a gates.py module because all four shells exec this
#  file as a single unit — the web app's Pyodide bridge, the PyPI CLI, the
#  VS Code subprocess and the Jupyter kernel runner. A second file would
#  mean teaching five loaders about it and buys nothing.
#
#  G-LEAK-SCALE is deliberately absent: the scaler-before-folds leak it
#  described is fixed in train() itself, and a check that can only ever
#  report "fine" is noise rather than rigor.
# ══════════════════════════════════════════════════════════════════════

#: Columns whose name alone says "not a feature". Matched case-insensitively
#: against the whole name, so a legitimate `id_score` is not caught.
_ID_NAMES = {"id", "index", "idx", "key", "uuid", "guid", "row", "rownum", "row_id",
             "customer_id", "user_id", "record_id", "unnamed: 0"}

#: Target names that read as deliberate rather than guessed.
_TARGET_NAMES = {"target", "label", "y", "class", "outcome", "response"}


def _gate(gate_id, severity, title, detail, **extra):
    out = {"id": gate_id, "severity": severity, "title": title, "detail": detail}
    out.update(extra)
    return out


def _looks_like_identifier(series) -> str | None:
    """Why this column is an identifier rather than a feature, or None."""
    name = str(series.name).strip().lower()
    if name in _ID_NAMES:
        return "its name"
    n = len(series)
    if n < 10:
        return None

    # Uniqueness only means "identifier" for integers and strings. A float
    # column of measurements is all-distinct almost by definition — CRIM, NOX
    # and RM in Boston Housing are 506 distinct floats and every one of them
    # is a real feature. Applying the rule to floats flagged nine of Boston's
    # thirteen columns as leaks, which is how a check earns being ignored.
    if series.dtype.kind == "f":
        return None

    distinct = int(series.nunique(dropna=True))
    if distinct == n and n > 20:
        return f"every one of its {n} values is distinct"
    # A strictly increasing integer column is a row number wearing a hat.
    try:
        if series.dtype.kind in "iu" and series.is_monotonic_increasing and distinct == n:
            return "it increases by row"
    except (AttributeError, TypeError):
        pass
    return None


#: Name tokens that mean "this column is a point in time". Matched as whole
#: tokens, never as substrings: `month` inside `tenure_months` is a duration
#: and `monthly_charges` is a rate, and treating either as a time axis is the
#: kind of false positive that gets a whole check muted.
_TIME_TOKENS = {"date", "dates", "time", "times", "datetime", "timestamp",
                "day", "week", "month", "year", "quarter", "created", "updated"}


def _looks_like_time(series) -> str | None:
    """Why this column is a point in time, or None."""
    if series.dtype.kind == "M":
        return "stored as a datetime"

    tokens = {t for t in re.split(r"[^a-z0-9]+", str(series.name).lower()) if t}
    if tokens & _TIME_TOKENS:
        return "its name"

    # A CSV has no dtypes, so a real date column arrives as text. Ask pandas
    # whether it parses, on a sample — cheap, and independent of the name.
    if series.dtype == object:
        sample = series.dropna().head(50)
        if len(sample) >= 10:
            try:
                parsed = pd.to_datetime(sample, errors="coerce", format="mixed")
                if parsed.notna().mean() >= 0.9:
                    return "its values parse as dates"
            except (ValueError, TypeError):
                pass
    return None


def run_gates(
    features: list | None = None,
    target: str | None = None,
    task_type: str | None = None,
    cv_folds: int = 5,
) -> dict:
    """Every check, against the currently loaded dataset. Never raises."""
    df = current_data["df"]
    if df is None:
        return {"gates": [], "counts": {"leak": 0, "decide": 0, "note": 0}, "ready": False}

    if hasattr(features, "to_py"):
        features = list(features.to_py())
    target = target or current_data.get("target")
    task_type = task_type or current_data.get("task_type") or "regression"
    numeric = current_data.get("numeric_columns") or []
    if features is None:
        features = [c for c in numeric if c != target]

    gates: list[dict] = []

    # ---- G-LEAK-ID — identifiers used as signal ----------------------
    suspects = []
    for column in features:
        if column not in df.columns:
            continue
        why = _looks_like_identifier(df[column])
        if why:
            suspects.append({"column": column, "why": why})
    if suspects:
        names = ", ".join(s["column"] for s in suspects)
        gates.append(_gate(
            "G-LEAK-ID", "leak",
            f"{len(suspects)} identifier-like column{'s' if len(suspects) > 1 else ''} in the features",
            f"{names} — a model can memorise a row id and score well without learning anything. "
            "Every reason is listed per column so you can overrule it.",
            columns=suspects,
            fix={"action": "drop_features", "features": [s["column"] for s in suspects]},
        ))

    # ---- G-DROPNA — rows that vanish before fitting -------------------
    if target and target in df.columns:
        used = [c for c in features if c in df.columns] + [target]
        total = int(len(df))
        complete = int(df[used].notna().all(axis=1).sum())
        dropped = total - complete
        if dropped:
            pct = 100.0 * dropped / total if total else 0.0
            gates.append(_gate(
                "G-DROPNA", "leak" if pct >= 20 else "note",
                f"{dropped} of {total} rows never reach the model",
                f"Rows with a missing value in any selected column are dropped before fitting "
                f"({pct:.1f}%). Scores describe the remaining {complete}. Dropping is only "
                "harmless when the missingness is unrelated to the target.",
                dropped=dropped, total=total, kept=complete,
            ))

    # ---- G-TARGET — the guess nobody confirmed ------------------------
    if target and str(target).strip().lower() not in _TARGET_NAMES:
        gates.append(_gate(
            "G-TARGET", "decide",
            f"Predicting {target} — is that right?",
            "No column was named target, so the last numeric column was used. "
            "Everything downstream depends on this being the thing you meant to predict.",
            options=[{"key": c, "label": c, "recommended": c == target} for c in numeric[:12]],
        ))

    # ---- G-TASK — a class label read as a quantity --------------------
    if target and target in df.columns and task_type == "regression":
        column = df[target].dropna()
        distinct = int(column.nunique())
        integral = column.dtype.kind in "iub" or bool((column == column.round()).all()) if len(column) else False
        if integral and 1 < distinct <= 20:
            gates.append(_gate(
                "G-TASK", "decide",
                f"{target} has {distinct} whole-number values — regression or classification?",
                "Fitting a regression to a class code optimises the distance between labels, "
                "which is meaningless when the labels are names. R² will look plausible either way.",
                options=[
                    {"key": "classification", "label": f"Classification — {distinct} classes", "recommended": True},
                    {"key": "regression", "label": "Regression — the values are genuinely ordered quantities"},
                ],
            ))

    # ---- G-CV-SPLITTER — one fold count for every dataset -------------
    if target and target in df.columns:
        n = int(df[target].notna().sum())
        if task_type == "classification":
            counts = df[target].value_counts()
            smallest = int(counts.min()) if len(counts) else 0
            share = (100.0 * smallest / n) if n else 0.0
            if smallest < cv_folds:
                gates.append(_gate(
                    "G-CV-SPLITTER", "decide",
                    f"The rarest class has {smallest} rows, fewer than the {cv_folds} folds",
                    "At least one fold will contain none of it, so the score for that class is "
                    "undefined and the average silently absorbs it.",
                    options=[
                        {"key": str(max(2, smallest)), "label": f"{max(2, smallest)}-fold — every fold gets the rare class", "recommended": True},
                        {"key": str(cv_folds), "label": f"Keep {cv_folds}-fold and accept the gap"},
                    ],
                ))
            elif len(counts) > 1:
                # Relative to balance, not an absolute percentage. Ten balanced
                # classes put every one of them at 10%, and an absolute "under
                # 20% is imbalanced" rule called MNIST-style digits imbalanced
                # — which is exactly backwards.
                fair = n / len(counts)
                if smallest < 0.5 * fair:
                    gates.append(_gate(
                        "G-CV-SPLITTER", "note",
                        f"Imbalanced target — the rarest class is {share:.1f}% of rows, "
                        f"where an even split would be {100 / len(counts):.1f}%",
                        "Accuracy rewards predicting the majority. The F1 column in the "
                        "comparison table is the one to read here.",
                    ))
        date_like = [(c, why) for c in df.columns if (why := _looks_like_time(df[c]))]
        if date_like:
            gates.append(_gate(
                "G-CV-TIME", "note",
                f"{date_like[0][0]} looks like a time axis",
                "Shuffled folds let the model train on the future and predict the past, so these "
                "scores may flatter a model you intend to run forward in time. Scikit-Learner only "
                "does shuffled k-fold — a time-ordered split means exporting the pipeline and "
                "swapping in TimeSeriesSplit. Noted rather than asked, because the app cannot "
                "currently offer you the other option.",
                columns=[{"column": c, "why": why} for c, why in date_like[:5]],
            ))

    # ---- G-MODEL-FIT — hyperparameters the data cannot support --------
    if target and target in df.columns:
        n = int(df[target].notna().sum())
        per_fold = int(n * (1 - 1 / max(cv_folds, 2)))
        catalogue = AVAILABLE_CLASSIFICATION_MODELS if task_type == "classification" else AVAILABLE_MODELS
        too_big = [
            info["name"]
            for info in catalogue.values()
            if isinstance(info["params"].get("n_neighbors"), int)
            and info["params"]["n_neighbors"] > per_fold
        ]
        if too_big:
            gates.append(_gate(
                "G-MODEL-FIT", "note",
                f"{len(too_big)} model{'s' if len(too_big) > 1 else ''} ask for more neighbours than a fold has rows",
                f"{', '.join(too_big)} — with {n} rows and {cv_folds} folds each fit sees about "
                f"{per_fold}. These will fail or average over nearly the whole training set.",
                models=too_big,
            ))

    counts = {"leak": 0, "decide": 0, "note": 0}
    for gate in gates:
        counts[gate["severity"]] += 1
    return {"gates": gates, "counts": counts, "ready": True}


def _ready() -> str:
    """Sanity probe — JS calls this to confirm the module loaded."""
    return "ok"
