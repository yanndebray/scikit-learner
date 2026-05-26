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

import io
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
    "adaboost_clf": {"name": "AdaBoost", "class": AdaBoostClassifier, "params": {"n_estimators": 50, "random_state": 42, "algorithm": "SAMME"}, "category": "Ensemble"},
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
            {"key": key, "name": info["name"], "params": _serializable_params(info["params"])}
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
    X = X[mask]
    y = y[mask]

    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    info = models_dict[model_type]
    model = info["class"](**info["params"])

    current_data["model_counter"] += 1
    model_id = f"model_{current_data['model_counter']}"

    if is_classification:
        cv_scores = cross_val_score(model, X_scaled, y, cv=cv_folds, scoring="accuracy")
        cv_predictions = cross_val_predict(model, X_scaled, y, cv=cv_folds)
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
        }

    # regression
    cv_scores_r2 = cross_val_score(model, X_scaled, y, cv=cv_folds, scoring="r2")
    cv_scores_mse = -cross_val_score(model, X_scaled, y, cv=cv_folds, scoring="neg_mean_squared_error")
    cv_predictions = cross_val_predict(model, X_scaled, y, cv=cv_folds)
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


def _ready() -> str:
    """Sanity probe — JS calls this to confirm the module loaded."""
    return "ok"
