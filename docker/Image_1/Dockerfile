FROM continuumio/miniconda3

LABEL org.opencontainers.image.title="Basic Python"
LABEL org.opencontainers.image.description="Lightweight Python 3.10 environment with essential data science libraries: numpy, pandas, matplotlib, seaborn, scikit-learn, pip."

# ------------------------------------------------------------
# Set working directory
# ------------------------------------------------------------
WORKDIR /app

# ------------------------------------------------------------
# Copy environment.yml first for caching
# ------------------------------------------------------------
COPY environment.yml .

# ------------------------------------------------------------
# Create the Conda environment
# ------------------------------------------------------------
RUN conda env create -f environment.yml

# ------------------------------------------------------------
# Activate conda environment automatically
# 1. Add 'conda activate mini_colab-py' to bashrc (for interactive shells)
# 2. Update PATH so python from mini_colab-py is used even in CMD/RUN
# ------------------------------------------------------------
RUN echo "conda activate mini_colab-py" >> ~/.bashrc
ENV PATH=/opt/conda/envs/mini_colab-py/bin:$PATH

# # ------------------------------------------------------------
# # Copy all project files
# # ------------------------------------------------------------
# COPY . .

# ------------------------------------------------------------
# Entrypoint: always use bash (so .bashrc loads)
# CMD: default command is 'tail -f /dev/null' (keeps container alive)
# ------------------------------------------------------------
ENTRYPOINT ["bash", "-l", "-c"]
CMD ["tail -f /dev/null"]
