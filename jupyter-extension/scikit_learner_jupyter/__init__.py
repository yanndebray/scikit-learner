"""Scikit-Learner for JupyterLab and JupyterLite.

A prebuilt (federated) labextension. There is no server extension and no
Python API — everything this package contains is JavaScript under
``labextension/``, which JupyterLab discovers through
``share/jupyter/labextensions`` and ``jupyter lite build`` copies into a
static site.

The Python that actually fits models is not here either: it is pushed into
whatever kernel the extension is using, because the environment a Jupyter
server runs in is routinely not the one its kernels run in, and JupyterLite
has no server at all. See ``python/learner_runner.py`` and
``scripts/gen-assets.mjs``.
"""

from ._version import __version__

__all__ = ["__version__", "_jupyter_labextension_paths"]


def _jupyter_labextension_paths():
    return [{"src": "labextension", "dest": "scikit-learner-jupyter"}]
